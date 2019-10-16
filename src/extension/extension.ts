import * as fs from "fs";
import * as path from "path";
import { isArray } from "util";
import * as vs from "vscode";
import { DaemonCapabilities, FlutterCapabilities } from "../shared/capabilities/flutter";
import { analyzerSnapshotPath, dartVMPath, flutterExtensionIdentifier, HAS_LAST_DEBUG_CONFIG, isWin, IS_RUNNING_LOCALLY_CONTEXT, platformDisplayName } from "../shared/constants";
import { LogCategory } from "../shared/enums";
import { DartWorkspaceContext, Sdks } from "../shared/interfaces";
import { captureLogs, EmittingLogger, logToConsole } from "../shared/logging";
import { internalApiSymbol } from "../shared/symbols";
import { isWithinPath } from "../shared/utils";
import { extensionVersion, isDevExtension } from "../shared/vscode/extension_utils";
import { InternalExtensionApi } from "../shared/vscode/interfaces";
import { fsPath, getDartWorkspaceFolders, isRunningLocally } from "../shared/vscode/utils";
import { Context } from "../shared/vscode/workspace";
import { WorkspaceContext } from "../shared/workspace";
import { Analyzer } from "./analysis/analyzer";
import { FileChangeHandler } from "./analysis/file_change_handler";
import { openFileTracker } from "./analysis/open_file_tracker";
import { Analytics } from "./analytics";
import { DartExtensionApi } from "./api";
import { cursorIsInTest } from "./commands/test";
import { config } from "./config";
import { DartCompletionItemProvider } from "./providers/dart_completion_item_provider";
import { DartFormattingEditProvider } from "./providers/dart_formatting_edit_provider";
import { DartDocumentHighlightProvider } from "./providers/dart_highlighting_provider";
import { DartHoverProvider } from "./providers/dart_hover_provider";
import { DartImplementationProvider } from "./providers/dart_implementation_provider";
import { DartReferenceProvider } from "./providers/dart_reference_provider";
import { DartRenameProvider } from "./providers/dart_rename_provider";
import { DebugConfigProvider } from "./providers/debug_config_provider";
import { SourceCodeActionProvider } from "./providers/source_code_action_provider";
import { PubGlobal } from "./pub/global";
import { DartCapabilities } from "./sdk/capabilities";
import { SdkUtils } from "./sdk/utils";
import * as util from "./utils";
import { addToLogHeader, clearLogHeader, getExtensionLogPath, getLogHeader } from "./utils/log";
import { safeSpawn } from "./utils/processes";
import { envUtils } from "./utils/vscode/editor";

const DART_MODE = { language: "dart", scheme: "file" };
const HTML_MODE = { language: "html", scheme: "file" };

const additionalModes = config.additionalAnalyzerFileExtensions.map((ext) => {
	return { scheme: "file", pattern: `**/*.${ext}` };
});

const DART_PROJECT_LOADED = "dart-code:dartProjectLoaded";
// TODO: Define what this means better. Some commands a general Flutter (eg. Hot
// Reload) and some are more specific (eg. Attach).
const FLUTTER_PROJECT_LOADED = "dart-code:anyFlutterProjectLoaded";
const FLUTTER_MOBILE_PROJECT_LOADED = "dart-code:flutterMobileProjectLoaded";
const FLUTTER_WEB_PROJECT_LOADED = "dart-code:flutterWebProjectLoaded";
export const FLUTTER_SUPPORTS_ATTACH = "dart-code:flutterSupportsAttach";
const DART_PLATFORM_NAME = "dart-code:dartPlatformName";
export const SERVICE_EXTENSION_CONTEXT_PREFIX = "dart-code:serviceExtension.";
export const SERVICE_CONTEXT_PREFIX = "dart-code:service.";

let analyzer: Analyzer;
const dartCapabilities = DartCapabilities.empty;
const flutterCapabilities = FlutterCapabilities.empty;
let analysisRoots: string[] = [];
let analytics: Analytics;

let showTodos: boolean | undefined;
let previousSettings: string;
const loggers: Array<{ dispose: () => Promise<void> | void }> = [];

// TODO: If dev mode, subscribe to logs for errors/warnings and surface to UI
// (with dispose calls)
const logger = new EmittingLogger();

export async function activate(context: vs.ExtensionContext, isRestart: boolean = false) {
	console.log("Activating extension!");
	if (isDevExtension)
		logToConsole(logger);

	vs.commands.executeCommand("setContext", IS_RUNNING_LOCALLY_CONTEXT, isRunningLocally);
	buildLogHeaders();
	setupLog(getExtensionLogPath(), LogCategory.General);

	const extContext = Context.for(context);

	util.logTime("Code called activate");

	// Wire up a reload command that will re-initialise everything.
	context.subscriptions.push(vs.commands.registerCommand("_dart.reloadExtension", async (_) => {
		logger.info("Performing silent extension reload...");
		await deactivate(true);
		const toDispose = context.subscriptions.slice();
		context.subscriptions.length = 0;
		for (const sub of toDispose) {
			try {
				sub.dispose();
			} catch (e) {
				logger.error(e);
			}
		}
		activate(context, true);
		logger.info("Done!");
	}));

	showTodos = config.showTodos;
	previousSettings = getSettingsThatRequireRestart();

	const sdkUtils = new SdkUtils(logger);
	const workspaceContextUnverified = await sdkUtils.scanWorkspace();

	analytics = new Analytics(logger, workspaceContextUnverified);

	const workspaceContext = workspaceContextUnverified as DartWorkspaceContext;
	const sdks = workspaceContext.sdks;

	// Fire up the analyzer process.
	const analyzerStartTime = new Date();
	const analyzerPath = config.analyzerPath || path.join(sdks.dart, analyzerSnapshotPath);
	// If the ssh host is set, then we are running the analyzer on a remote machine, that same analyzer
	// might not exist on the local machine.
	if (!config.analyzerSshHost && !fs.existsSync(analyzerPath)) {
		vs.window.showErrorMessage("Could not find a Dart Analysis Server at " + analyzerPath);
		return;
	}

	analyzer = new Analyzer(logger, path.join(sdks.dart, dartVMPath), analyzerPath);
	context.subscriptions.push(analyzer);

	const nextAnalysis = () =>
		new Promise<void>((resolve, reject) => {
			const disposable = analyzer.registerForServerStatus((ss) => {
				if (ss.analysis && !ss.analysis.isAnalyzing) {
					resolve();
					disposable.dispose();
				}
			});
		});

	// Set up providers.
	// TODO: Do we need to push all these to subscriptions?!
	const hoverProvider = new DartHoverProvider(logger, analyzer);
	const formattingEditProvider = new DartFormattingEditProvider(logger, analyzer, extContext);
	context.subscriptions.push(formattingEditProvider);
	const completionItemProvider = new DartCompletionItemProvider(logger, analyzer);
	const referenceProvider = new DartReferenceProvider(analyzer);
	const documentHighlightProvider = new DartDocumentHighlightProvider();
	const sourceCodeActionProvider = new SourceCodeActionProvider();

	const renameProvider = new DartRenameProvider(analyzer);
	const implementationProvider = new DartImplementationProvider(analyzer);

	const activeFileFilters: vs.DocumentSelector = [DART_MODE];

	if (config.analyzeAngularTemplates) {
		// Analyze files supported by plugins
		activeFileFilters.push(HTML_MODE);
		activeFileFilters.push(...additionalModes);
	}

	const triggerCharacters = ".(${'\"/\\".split("");
	context.subscriptions.push(vs.languages.registerHoverProvider(activeFileFilters, hoverProvider));
	formattingEditProvider.registerDocumentFormatter(activeFileFilters);
	context.subscriptions.push(vs.languages.registerCompletionItemProvider(activeFileFilters, completionItemProvider, ...triggerCharacters));
	context.subscriptions.push(vs.languages.registerDefinitionProvider(activeFileFilters, referenceProvider));
	context.subscriptions.push(vs.languages.registerReferenceProvider(activeFileFilters, referenceProvider));
	context.subscriptions.push(vs.languages.registerDocumentHighlightProvider(activeFileFilters, documentHighlightProvider));
	context.subscriptions.push(vs.languages.registerRenameProvider(activeFileFilters, renameProvider));

	// Some actions only apply to Dart.
	formattingEditProvider.registerTypingFormatter(DART_MODE, "}", ";");
	context.subscriptions.push(vs.languages.registerCodeActionsProvider(DART_MODE, sourceCodeActionProvider, sourceCodeActionProvider.metadata));

	context.subscriptions.push(vs.languages.registerImplementationProvider(DART_MODE, implementationProvider));

	// TODO: Currently calculating analysis roots requires the version to check if
	// we need the package workaround. In future if we stop supporting server < 1.20.1 we
	// can unwrap this call so that it'll start sooner.
	const serverConnected = analyzer.registerForServerConnected((sc) => {
		serverConnected.dispose();
		recalculateAnalysisRoots();

		// Set up a handler to warn the user if they open a Dart file and we
		// never set up the analyzer
		let hasWarnedAboutLooseDartFiles = false;
		const handleOpenFile = (d: vs.TextDocument) => {
			if (d.languageId === "dart" && analysisRoots.length === 0 && !hasWarnedAboutLooseDartFiles) {
				hasWarnedAboutLooseDartFiles = true;
				vs.window.showWarningMessage("For full Dart language support, please open a folder containing your Dart files instead of individual loose files");
			}
		};
		context.subscriptions.push(vs.workspace.onDidOpenTextDocument((d) => handleOpenFile(d)));
		// Fire for editors already visible at the time this code runs.
		vs.window.visibleTextEditors.forEach((e) => handleOpenFile(e.document));
	});

	// Hook editor changes to send updated contents to analyzer.
	context.subscriptions.push(new FileChangeHandler(analyzer));

	util.logTime("All other stuff before debugger..");

	const pubGlobal = new PubGlobal(logger, extContext, sdks);

	// Set up debug stuff.
	const debugProvider = new DebugConfigProvider(logger, sdks, analytics, pubGlobal, undefined, undefined, dartCapabilities, flutterCapabilities);
	context.subscriptions.push(vs.debug.registerDebugConfigurationProvider("dart", debugProvider));
	context.subscriptions.push(debugProvider);

	// Setup that requires server version/capabilities.
	const connectedSetup = analyzer.registerForServerConnected((sc) => {
		connectedSetup.dispose();

		context.subscriptions.push(openFileTracker.create(logger, analyzer, workspaceContext));

		// Set up completions for unimported items.
		if (analyzer.capabilities.supportsAvailableSuggestions && config.autoImportCompletions) {
			analyzer.completionSetSubscriptions({
				subscriptions: ["AVAILABLE_SUGGESTION_SETS"],
			});
		}
	});

	console.log("Has finished activating extension!");

	return {
		...new DartExtensionApi(),
		[internalApiSymbol]: {
			analyzerCapabilities: analyzer.capabilities,
			cancelAllAnalysisRequests: () => analyzer.cancelAllRequests(),
			completionItemProvider,
			context: extContext,
			currentAnalysis: () => analyzer.currentAnalysis,
			get cursorIsInTest() { return cursorIsInTest; },
			daemonCapabilities: DaemonCapabilities.empty,
			dartCapabilities,
			debugCommands: undefined,
			debugProvider,
			envUtils,
			fileTracker: openFileTracker,
			flutterCapabilities,
			flutterOutlineTreeProvider: undefined,
			getLogHeader,
			initialAnalysis: undefined,
			logger,
			nextAnalysis,
			packagesTreeProvider: undefined,
			pubGlobal,
			renameProvider,
			safeSpawn,
			testTreeProvider: undefined,
			workspaceContext,
		} as InternalExtensionApi,
	};
}

function setupLog(logFile: string | undefined, category: LogCategory) {
	if (logFile)
		loggers.push(captureLogs(logger, logFile, getLogHeader(), config.maxLogLineLength, [category]));
}

function buildLogHeaders(workspaceContext?: WorkspaceContext) {
	clearLogHeader();
	addToLogHeader(() => `!! PLEASE REVIEW THIS LOG FOR SENSITIVE INFORMATION BEFORE SHARING !!`);
	addToLogHeader(() => ``);
	addToLogHeader(() => `Dart Code extension: ${extensionVersion}`);
	addToLogHeader(() => {
		const ext = vs.extensions.getExtension(flutterExtensionIdentifier)!;
		return `Flutter extension: ${ext.packageJSON.version} (${ext.isActive ? "" : "not "}activated)`;
	});
	addToLogHeader(() => `VS Code: ${vs.version}`);
	addToLogHeader(() => `Platform: ${platformDisplayName}`);
	if (workspaceContext) {
		addToLogHeader(() => `Workspace type: ${workspaceContext.workspaceTypeDescription}`);
		addToLogHeader(() => `Multi-root?: ${vs.workspace.workspaceFolders && vs.workspace.workspaceFolders.length > 1}`);
		const sdks = workspaceContext.sdks;
		addToLogHeader(() => `Dart SDK:\n    Loc: ${sdks.dart}\n    Ver: ${util.getSdkVersion(logger, sdks.dart)}`);
		addToLogHeader(() => `Flutter SDK:\n    Loc: ${sdks.flutter}\n    Ver: ${util.getSdkVersion(logger, sdks.flutter)}`);
	}
	addToLogHeader(() => `HTTP_PROXY: ${process.env.HTTP_PROXY}`);
	addToLogHeader(() => `NO_PROXY: ${process.env.NO_PROXY}`);
}

function recalculateAnalysisRoots() {
	analysisRoots = getDartWorkspaceFolders().map((w) => fsPath(w.uri));

	// Sometimes people open their home directories as the workspace root and
	// have all sorts of performance issues because of PubCache and AppData folders
	// so we will exclude them if the user has opened a parent folder (opening a
	// child of these directly will still work).
	const excludeFolders: string[] = [];
	if (isWin) {
		const addExcludeIfRequired = (folder: string | undefined) => {
			if (!folder || !path.isAbsolute(folder))
				return;
			const containingRoot = analysisRoots.find((root: string) => isWithinPath(folder, root));
			if (containingRoot) {
				logger.info(`Excluding folder ${folder} from analysis roots as it is a child of analysis root ${containingRoot} and may cause performance issues.`);
				excludeFolders.push(folder);
			}
		};

		addExcludeIfRequired(process.env.PUB_CACHE);
		addExcludeIfRequired(process.env.APPDATA);
		addExcludeIfRequired(process.env.LOCALAPPDATA);
	}

	// For each workspace, handle excluded folders.
	getDartWorkspaceFolders().forEach((f) => {
		const excludedForWorkspace = config.for(f.uri).analysisExcludedFolders;
		const workspacePath = fsPath(f.uri);
		if (excludedForWorkspace && isArray(excludedForWorkspace)) {
			excludedForWorkspace.forEach((folder) => {
				// Handle both relative and absolute paths.
				if (!path.isAbsolute(folder))
					folder = path.join(workspacePath, folder);
				excludeFolders.push(folder);
			});
		}
	});

	analyzer.analysisSetAnalysisRoots({
		excluded: excludeFolders,
		included: analysisRoots,
	});
}

function handleConfigurationChange(sdks: Sdks) {
	// TODOs
	const newShowTodoSetting = config.showTodos;
	const todoSettingChanged = showTodos !== newShowTodoSetting;
	showTodos = newShowTodoSetting;

	// SDK
	const newSettings = getSettingsThatRequireRestart();
	const settingsChanged = previousSettings !== newSettings;
	previousSettings = newSettings;

	if (todoSettingChanged) {
		analyzer.analysisReanalyze();
	}

	if (settingsChanged) {
		util.reloadExtension();
	}
}

function getSettingsThatRequireRestart() {
	// The return value here is used to detect when any config option changes that requires a project reload.
	// It doesn't matter how these are combined; it just gets called on every config change and compared.
	// Usually these are options that affect the analyzer and need a reload, but config options used at
	// activation time will also need to be included.
	return "CONF-"
		+ config.sdkPath
		+ config.analyzerPath
		+ config.analyzerDiagnosticsPort
		+ config.analyzerObservatoryPort
		+ config.analyzerInstrumentationLogFile
		+ config.extensionLogFile
		+ config.analyzerAdditionalArgs
		+ config.flutterSdkPath
		+ config.flutterSelectDeviceWhenConnected
		+ config.closingLabels
		+ config.analyzeAngularTemplates
		+ config.analysisServerFolding
		+ config.showTestCodeLens
		+ config.previewHotReloadCoverageMarkers
		+ config.previewBuildRunnerTasks
		+ config.flutterOutline
		+ config.triggerSignatureHelpAutomatically
		+ config.flutterAdbConnectOnChromeOs;
}

export async function deactivate(isRestart: boolean = false): Promise<void> {
	setCommandVisiblity(false);
	vs.commands.executeCommand("setContext", FLUTTER_SUPPORTS_ATTACH, false);
	if (!isRestart) {
		vs.commands.executeCommand("setContext", HAS_LAST_DEBUG_CONFIG, false);
		await analytics.logExtensionShutdown();
		if (loggers) {
			await Promise.all(loggers.map((logger) => logger.dispose()));
			loggers.length = 0;
		}
	}
}

function setCommandVisiblity(enable: boolean, workspaceContext?: WorkspaceContext) {
	vs.commands.executeCommand("setContext", DART_PROJECT_LOADED, enable);
	// TODO: Make this more specific. Maybe the one above?
	vs.commands.executeCommand("setContext", FLUTTER_PROJECT_LOADED, enable && workspaceContext && workspaceContext.hasAnyFlutterProjects);
	vs.commands.executeCommand("setContext", FLUTTER_MOBILE_PROJECT_LOADED, enable && workspaceContext && workspaceContext.hasAnyFlutterMobileProjects);
	vs.commands.executeCommand("setContext", FLUTTER_WEB_PROJECT_LOADED, enable && workspaceContext && workspaceContext.hasAnyFlutterWebProjects);
}
