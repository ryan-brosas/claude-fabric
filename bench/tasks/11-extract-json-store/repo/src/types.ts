export interface Project {
  id: string;
  name: string;
  createdAt: string;
}

export interface Note {
  id: string;
  projectId: string;
  body: string;
  createdAt: string;
}
