import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';

type WorkspaceChromeValue = {
  hidden: boolean;
  setHidden: (hidden: boolean) => void;
  toggle: () => void;
};

const STORAGE_KEY = 'notomi.workspace.chrome-hidden.v1';
const WorkspaceChromeContext = createContext<WorkspaceChromeValue | null>(null);

function initialHidden(): boolean {
  if (Platform.OS !== 'web' || typeof localStorage === 'undefined') return false;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function WorkspaceChromeProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(initialHidden);

  useEffect(() => {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, String(hidden));
    }
  }, [hidden]);

  const toggle = useCallback(() => setHidden((current) => !current), []);
  const value = useMemo(() => ({ hidden, setHidden, toggle }), [hidden, toggle]);

  return <WorkspaceChromeContext.Provider value={value}>{children}</WorkspaceChromeContext.Provider>;
}

export function useWorkspaceChrome(): WorkspaceChromeValue {
  const value = useContext(WorkspaceChromeContext);
  if (!value) throw new Error('useWorkspaceChrome must be used inside WorkspaceChromeProvider.');
  return value;
}
