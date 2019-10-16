console.log("Starting test runner...");

import * as glob from "glob";
import * as Mocha from "mocha";
import * as path from "path";

export function run(): Promise<void> {
	return new Promise((resolve, reject) => {

		// Create the mocha test
		const mocha = new Mocha({ ui: "bdd" });

		const testsRoot = path.resolve(__dirname, '..');
		glob("**/**.test.js", { cwd: testsRoot }, (err, files) => {
			if (err) {
				return reject(err);
			}

			// Add files to the test suite
			files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));

			try {
				// Run the mocha test
				mocha.run((_) => resolve());
			} catch (err) {
				reject(err);
			}
		});
	});
};
