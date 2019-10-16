import * as path from "path";
import * as vs from "vscode";
import { analyzerSnapshotPath, dartVMPath } from "../shared/constants";
import { DartWorkspaceContext } from "../shared/interfaces";
import { EmittingLogger } from "../shared/logging";
import { Analyzer } from "./analysis/analyzer";
import { config } from "./config";
import { SdkUtils } from "./sdk/utils";

export const FLUTTER_SUPPORTS_ATTACH = "dart-code:flutterSupportsAttach";
export const SERVICE_EXTENSION_CONTEXT_PREFIX = "dart-code:serviceExtension.";
export const SERVICE_CONTEXT_PREFIX = "dart-code:service.";

let analyzer: Analyzer;

// TODO: If dev mode, subscribe to logs for errors/warnings and surface to UI
// (with dispose calls)
const logger = new EmittingLogger();

export async function activate(context: vs.ExtensionContext, isRestart: boolean = false) {
	console.log("Activating extension!");

	const sdkUtils = new SdkUtils(logger);
	const workspaceContextUnverified = await sdkUtils.scanWorkspace();

	const workspaceContext = workspaceContextUnverified as DartWorkspaceContext;
	const sdks = workspaceContext.sdks;

	// Fire up the analyzer process.
	const analyzerPath = config.analyzerPath || path.join(sdks.dart, analyzerSnapshotPath);

	analyzer = new Analyzer(logger, path.join(sdks.dart, dartVMPath), analyzerPath);
	context.subscriptions.push(analyzer);

	console.log("Has finished activating extension!");

}

export async function deactivate(isRestart: boolean = false): Promise<void> {
	console.log("Extension deactivating!");
}
