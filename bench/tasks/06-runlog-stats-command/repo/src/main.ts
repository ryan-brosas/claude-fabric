import { run } from "./cli";

const code = await run(process.argv.slice(2));
process.exit(code);
