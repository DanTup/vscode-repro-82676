import * as vs from "vscode";

export const FLUTTER_SUPPORTS_ATTACH = "dart-code:flutterSupportsAttach";
export const SERVICE_EXTENSION_CONTEXT_PREFIX = "dart-code:serviceExtension.";
export const SERVICE_CONTEXT_PREFIX = "dart-code:service.";

export async function activate(context: vs.ExtensionContext, isRestart: boolean = false) {
	console.log("Activating extension!");

	console.log("Has finished activating extension!");
}

export async function deactivate(isRestart: boolean = false): Promise<void> {
	console.log("Extension deactivating!");
}
