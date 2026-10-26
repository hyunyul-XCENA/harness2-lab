import {runHarness2} from '../src/harness2.js';
import {errorText} from '../src/util.js';
try {process.exitCode = await runHarness2(process.argv.slice(2));}
catch (error) {console.error(errorText(error)); process.exitCode = 1;}
