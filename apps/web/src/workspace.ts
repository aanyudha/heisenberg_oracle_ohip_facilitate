import { createContext, useContext } from "react";
import type { Identity } from "@hospitality/contracts";
export type Workspace = {
  user: Identity & { developer: boolean };
  propertyId: string;
  date: string;
  selectProperty?: (id: string) => void;
};
export const Context = createContext<Workspace>(null!);
export const useWorkspace = () => useContext(Context);
