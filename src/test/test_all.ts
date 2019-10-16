import * as fs from "fs";
import * as path from "path";
import * as vstest from "vscode-test";

let exitCode = 0;
const cwd = process.cwd();
const testEnv = Object.create(process.env);

function yellow(message: string): string { return color(93, message); }
function color(col: number, message: string) {
	return "\u001b[" + col + "m" + message + "\u001b[0m";
}

async function runTests(testFolder: string, workspaceFolder: string, sdkPaths: string, codeVersion: string | undefined): Promise<void> {
	console.log("\n\n");
	console.log(yellow("############################################################"));
	console.log(
		yellow("## ")
		+ `Running using ${yellow(testFolder)}`
		+ ` in workspace ${yellow(workspaceFolder)}`
		+ ` using version ${yellow(codeVersion || "stable")} of Code`);
	console.log(`${yellow("##")} Looking for SDKs in:`);
	sdkPaths
		.split(path.delimiter)
		.filter((p) => p && p.toLowerCase().indexOf("dart") !== -1 || p.toLowerCase().indexOf("flutter") !== -1)
		.forEach((p) => console.log(`${yellow("##")}    ${p}`));
	console.log(yellow("############################################################"));

	// For some reason, updating PATH here doesn't get through to Code
	// even though other env vars do! 😢
	testEnv.DART_PATH_OVERRIDE = sdkPaths;
	testEnv.CODE_VERSION = codeVersion;

	// Figure out a filename for results...
	const dartFriendlyName = (process.env.ONLY_RUN_DART_VERSION || "local").toLowerCase();
	const codeFriendlyName = codeVersion || "stable";

	// Set some paths that are used inside the test run.
	const testRunName = testFolder.replace("/", "_");
	testEnv.TEST_RUN_NAME = testRunName;
	testEnv.DC_TEST_LOGS = path.join(cwd, ".dart_code_test_logs", `${testRunName}_${dartFriendlyName}_${codeFriendlyName}`);
	testEnv.COVERAGE_OUTPUT = path.join(cwd, ".nyc_output", `${testRunName}_${dartFriendlyName}_${codeFriendlyName}.json`);
	testEnv.TEST_XML_OUTPUT = path.join(cwd, ".test_results", `${testRunName}_${dartFriendlyName}_${codeFriendlyName}.xml`);
	testEnv.TEST_CSV_SUMMARY = path.join(cwd, ".test_results", `${dartFriendlyName}_${codeFriendlyName}_summary.csv`);

	if (!fs.existsSync(testEnv.DC_TEST_LOGS))
		fs.mkdirSync(testEnv.DC_TEST_LOGS);

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
			version: codeVersion,
		});
		exitCode = exitCode || res;
	} catch (e) {
		console.error(e);
		exitCode = exitCode || 999;
	}

	console.log(yellow("############################################################"));
	console.log("\n\n");
}

async function runAllTests(): Promise<void> {
	const codeVersion = process.env.ONLY_RUN_CODE_VERSION === "DEV" ? "insiders" : undefined;
	const dartSdkPath = process.env.DART_PATH_SYMLINK || process.env.DART_PATH || process.env.PATH;

	testEnv.DART_CODE_IS_TEST_RUN = true;
	testEnv.MOCHA_FORBID_ONLY = true;

	// Ensure any necessary folders exist.
	if (!fs.existsSync(".nyc_output"))
		fs.mkdirSync(".nyc_output");
	if (!fs.existsSync(".dart_code_test_logs"))
		fs.mkdirSync(".dart_code_test_logs");

	try {
		await runTests("dart_create_tests", "dart_create_tests.code-workspace", dartSdkPath, codeVersion);
	} catch (e) {
		exitCode = 1;
		console.error(e);
	}
}

runAllTests().then(() => process.exit(exitCode));
