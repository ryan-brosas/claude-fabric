export type { Note, Project } from "./types";
export { dataDir, dataFile } from "./storage/paths";
export { createProject, listProjects } from "./services/projects";
export { addNote, listNotes } from "./services/notes";
export { newId } from "./util/ids";
export { NotFoundError, ValidationError } from "./util/errors";
