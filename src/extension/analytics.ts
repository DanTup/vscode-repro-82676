import { env, Uri, workspace } from "vscode";
import { dartCodeExtensionIdentifier } from "../shared/constants";
import { Logger } from "../shared/interfaces";
import { isDevExtension } from "../shared/vscode/extension_utils";
import { WorkspaceContext } from "../shared/workspace";
import { config } from "./config";

// Set to true for analytics to be sent to the debug endpoint (non-logging) for validation.
// This is only required for debugging analytics and needn't be sent for standard Dart Code development (dev hits are already filtered with isDevelopment).
const debug = false;

/// Analytics require that we send a value for uid or cid, but when running in the VS Code
// dev host we don't have either.
const sendAnalyticsFromExtensionDevHost = false;

// Machine ID is not set for extension dev host unless the boolean above is set to true (which
// is usually done for testing purposes).
const machineId = env.machineId !== "someValue.machineId"
	? env.machineId
	: (sendAnalyticsFromExtensionDevHost ? "35009a79-1a05-49d7-dede-dededededede" : undefined);

enum Category {
	Extension,
	Analyzer,
	Debugger,
}

enum EventAction {
	Activated,
	SdkDetectionFailure,
	Deactivated,
	Restart,
	HotReload,
	OpenObservatory,
	OpenTimeline,
	OpenDevTools,
}

enum TimingVariable {
	Startup,
	FirstAnalysis,
	SessionDuration,
}

export class Analytics {
	public sdkVersion?: string;
	public flutterSdkVersion?: string;
	public analysisServerVersion?: string;
	private readonly formatter: string;
	private readonly dummyDartFile = Uri.parse("untitled:foo.dart");
	private readonly dartConfig = workspace.getConfiguration("", this.dummyDartFile).get("[dart]") as any;

	constructor(private readonly logger: Logger, public workspaceContext: WorkspaceContext) {
		this.formatter = this.getFormatterSetting();
	}

	private getFormatterSetting(): string {
		try {
			// If there are multiple formatters for Dart, the user can select one, so check
			// that first so we don't record their formatter being enabled as ours.
			const otherDefaultFormatter = this.getAppliedConfig("editor", "defaultFormatter", false);
			if (otherDefaultFormatter && otherDefaultFormatter !== dartCodeExtensionIdentifier)
				return otherDefaultFormatter;

			// If the user has explicitly disabled ours (without having another selected
			// then record that).
			if (!config.enableSdkFormatter)
				return "Disabled";

			// Otherwise record as enabled (and whether on-save).
			return this.getAppliedConfig("editor", "formatOnSave")
				? "Enabled on Save"
				: "Enabled";
		} catch {
			return "Unknown";
		}
	}

	private getAppliedConfig(section: string, key: string, isResourceScoped = true) {
		const dartValue = this.dartConfig ? this.dartConfig[`${section}.${key}`] : undefined;
		return dartValue !== undefined && dartValue !== null
			? dartValue
			: workspace.getConfiguration(section, isResourceScoped ? this.dummyDartFile : undefined).get(key);
	}

	public logExtensionStartup(timeInMS: number) {
		this.event(Category.Extension, EventAction.Activated);
		this.time(Category.Extension, TimingVariable.Startup, timeInMS);
	}
	public logExtensionRestart(timeInMS: number) {
		this.event(Category.Extension, EventAction.Restart);
		this.time(Category.Extension, TimingVariable.Startup, timeInMS);
	}
	public logExtensionShutdown(): PromiseLike<void> { return this.event(Category.Extension, EventAction.Deactivated); }
	public logSdkDetectionFailure() { this.event(Category.Extension, EventAction.SdkDetectionFailure); }
	public logAnalyzerError(description: string, fatal: boolean) { this.error("AS: " + description, fatal); }
	public logAnalyzerStartupTime(timeInMS: number) { this.time(Category.Analyzer, TimingVariable.Startup, timeInMS); }
	public logDebugSessionDuration(debuggerType: string, timeInMS: number) { this.time(Category.Debugger, TimingVariable.SessionDuration, timeInMS, debuggerType); }
	public logAnalyzerFirstAnalysisTime(timeInMS: number) { this.time(Category.Analyzer, TimingVariable.FirstAnalysis, timeInMS); }
	public logDebuggerStart(resourceUri: Uri | undefined, debuggerType: string, runType: string) {
		const customData = {
			cd15: debuggerType,
			cd16: runType,
		};
		this.event(Category.Debugger, EventAction.Activated, resourceUri, customData);
	}
	public logDebuggerRestart() { this.event(Category.Debugger, EventAction.Restart); }
	public logDebuggerHotReload() { this.event(Category.Debugger, EventAction.HotReload); }
	public logDebuggerOpenObservatory() { this.event(Category.Debugger, EventAction.OpenObservatory); }
	public logDebuggerOpenTimeline() { this.event(Category.Debugger, EventAction.OpenTimeline); }
	public logDebuggerOpenDevTools() { this.event(Category.Debugger, EventAction.OpenDevTools); }

	private event(category: Category, action: EventAction, resourceUri?: Uri, customData?: any): PromiseLike<void> {
		const data: any = {
			ea: EventAction[action],
			ec: Category[category],
			t: "event",
		};

		// Copy custom data over.
		Object.assign(data, customData);

		// Force a session start if this is extension activation.
		if (category === Category.Extension && action === EventAction.Activated)
			data.sc = "start";

		// Force a session end if this is extension deactivation.
		if (category === Category.Extension && action === EventAction.Deactivated)
			data.sc = "end";

		return this.send(data, resourceUri);
	}

	private time(category: Category, timingVariable: TimingVariable, timeInMS: number, label?: string) {
		const data: any = {
			t: "timing",
			utc: Category[category],
			utl: label,
			utt: Math.round(timeInMS),
			utv: TimingVariable[timingVariable],
		};

		this.logger.info(`${data.utc}:${data.utv} timing: ${Math.round(timeInMS)}ms ${label ? `(${label})` : ""}`);
		if (isDevExtension)
			console.log(`${data.utc}:${data.utv} timing: ${Math.round(timeInMS)}ms ${label ? `(${label})` : ""}`);

		this.send(data);
	}

	private error(description: string, fatal: boolean) {
		const data: any = {
			exd: description.split(/[\n\{\/\\]/)[0].substring(0, 150).trim(),
			exf: fatal ? 1 : 0,
			t: "exception",
		};

		this.send(data);
	}

	private async send(customData: any, resourceUri?: Uri): Promise<void> {
		// Do nothing
	}
}
