import * as path from "path";
import * as vstest from "vscode-test";

let exitCode = 0;
const cwd = process.cwd();
const testEnv = Object.create(process.env);

async function runAllTests(): Promise<void> {
	console.log("Starting test run!");
	try {
		const testFolder = "dart_create_tests";
		const workspaceFolder = "dart_create_tests.code-workspace";
		try {
			const res = await vstest.runTests({
				extensionDevelopmentPath: cwd,
				extensionTestsEnv: testEnv,
				extensionTestsPath: path.join(cwd, "out", "src", "test", testFolder),
				launchArgs: [
					path.isAbsolute(workspaceFolder)
						? workspaceFolder
						: path.join(cwd, "src", "test", "test_projects", workspaceFolder),
					"--user-data-dir",
					path.join(cwd, ".dart_code_test_data_dir"),
				],
				version: process.env.CODE_VERSION,
			});
			exitCode = exitCode || res;
		} catch (e) {
			console.error(e);
			exitCode = exitCode || 999;
		}
	} catch (e) {
		exitCode = 1;
		console.error(e);
	}
	console.log("Test run complete!");
}

runAllTests().then(() => process.exit(exitCode));
