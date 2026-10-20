export interface XLoginOptions {
  username?: string;
  password?: string;
  timeoutMs?: number;
  onProgress?: (msg: string) => void;
}

export interface XAuthStatus {
  loggedIn: boolean;
  hasAuthToken: boolean;
  usernameConfigured: boolean;
}
