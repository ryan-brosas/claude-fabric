import { resolve } from "node:path";
import { z } from "zod";
import { defineAction } from "../../registry/action.ts";

export const Write = defineAction({
  name: "Write",
  doc: "Create or overwrite a file with content.",
  input: z.object({
    file_path: z.string().min(1).describe("Path from the project root, or absolute."),
    content: z.string().describe("The whole new file content."),
  }),
  output: z.string(),
  positional: ["file_path", "content"],
  run: async (i, { cwd }) => {
    await Bun.write(resolve(cwd, i.file_path), i.content);
    return "Wrote " + i.content.length + " chars to " + i.file_path;
  },
});
