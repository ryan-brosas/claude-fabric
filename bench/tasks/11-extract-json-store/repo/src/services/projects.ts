import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { dataFile } from "../storage/paths";
import type { Project } from "../types";
import { ValidationError } from "../util/errors";
import { newId } from "../util/ids";

type Env = Record<string, string | undefined>;

export async function listProjects(env: Env = process.env): Promise<Project[]> {
  const path = dataFile("projects", env);
  try {
    const text = await Bun.file(path).text();
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as Project[]) : [];
  } catch {
    return [];
  }
}

export async function createProject(
  input: { name: string },
  env: Env = process.env,
): Promise<Project> {
  const name = input.name.trim();
  if (name.length === 0) throw new ValidationError("project name must not be empty");

  const projects = await listProjects(env);
  const project: Project = { id: newId("prj"), name, createdAt: new Date().toISOString() };
  projects.push(project);

  const path = dataFile("projects", env);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(projects, null, 2));
  return project;
}
