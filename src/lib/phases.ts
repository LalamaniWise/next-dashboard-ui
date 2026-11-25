import type { SchoolPhase } from "@prisma/client";

// Kept free of server-only imports so the registration forms can use it too

export const PHASES: SchoolPhase[] = ["PRIMARY", "SECONDARY"];

export const phaseLabels: Record<SchoolPhase, string> = {
  PRIMARY: "Primary school (Grade R to 7)",
  SECONDARY: "Secondary school (Grade 8 to 12)",
};

// Grade R is level 0
export const phaseOf = (level: number): SchoolPhase => (level <= 7 ? "PRIMARY" : "SECONDARY");

export const gradeLabel = (level: number) => (level === 0 ? "Grade R" : `Grade ${level}`);
