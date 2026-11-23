export interface UserProfile {
  id: string;
  plan: string;
  region: string;
}

export interface SearchRow {
  id: string;
  title: string;
}

export interface Session {
  id: string;
  userId: string;
}
