import { resolve } from "node:path";
import { z } from "zod";
import { defineAction } from "../../registry/action.ts";

export const Edit = defineAction({
  name: "Edit",
  doc: "Replace old_string with new_string. old_string must match exactly once unless replace_all.",
  input: z.object({
    file_path: z.string().min(1).describe("Path from the project root, or absolute."),
    old_string: z.string().min(1).describe("The text to replace."),
    new_string: z.string().describe("The replacement text."),
    replace_all: z.boolean().optional().describe("Replace every match, not only a unique one."),
  }),
  output: z.string(),
  positional: ["file_path", "old_string", "new_string"],
  run: async (i, { cwd }) => {
    if (i.old_string === i.new_string) throw new Error("old_string and new_string are the same");
    const file = Bun.file(resolve(cwd, i.file_path));
    if (!(await file.exists())) throw new Error("File does not exist: " + i.file_path);
    const text = await file.text();
    const count = text.split(i.old_string).length - 1;
    if (count === 0) throw new Error("old_string not found in " + i.file_path);
    if (count > 1 && !i.replace_all) throw new Error("old_string matches " + count + " times in " + i.file_path + "; add context to make it unique or set replace_all: true");
    await Bun.write(resolve(cwd, i.file_path), i.replace_all ? text.split(i.old_string).join(i.new_string) : text.replace(i.old_string, () => i.new_string));
    const replaced = i.replace_all ? count : 1;
    return "Edited " + i.file_path + " (" + replaced + " replacement" + (replaced === 1 ? "" : "s") + ")";
  },
});
