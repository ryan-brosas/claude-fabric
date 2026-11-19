import { Bash } from "./bash.ts";
import { Edit } from "./edit.ts";
import { Glob } from "./glob.ts";
import { Grep } from "./grep.ts";
import { Read } from "./read.ts";
import { WebSearch } from "./websearch.ts";
import { Write } from "./write.ts";

// The program tools, in the order a program sees them. This list is the only one.
export const TOOLS = [Read, Write, Edit, Grep, Glob, Bash, WebSearch];
