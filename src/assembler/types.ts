import { Buffer } from 'buffer';

export type SourceOrigin = {
  file?: string;
  line: number;
  macroScope?: string;
  macroInstance?: {
    name: string;
    ordinal: number;
    callerFile?: string;
    callerLine?: number;
  };
};

export type AssembleResult = {
  success: boolean;
  output?: Buffer;
  map?: Record<number, number>;
  errors?: string[];
  warnings?: string[];
  labels?: Record<string, { addr: number; line: number; src?: string }>;
  origins?: SourceOrigin[];
};

export type MacroParam = { name: string; defaultValue?: string };

export type MacroDefinition = {
  name: string;
  params: MacroParam[];
  body: Array<{ line: string; origin: SourceOrigin }>;
  startLine: number;
  sourceFile?: string;
  invocationCount: number;
  normalLabels: Set<string>;
};

export type WordLiteralResult = { value: number } | { error: string };

export type LocalLabelRecord = { key: string; line: number };
export type LocalLabelScopeIndex = Map<string, Map<string, LocalLabelRecord[]>>;

export type ExpressionEvalContext = {
  labels: Map<string, { addr: number; line: number; src?: string }>;
  consts: Map<string, number>;
  localsIndex: LocalLabelScopeIndex;
  scopes: string[];
  lineIndex: number;
};

export type IfFrame = {
  effective: boolean;
  suppressed: boolean;
  origin?: SourceOrigin;
  lineIndex: number;
};

export type LoopExpansionResult = {
  lines: string[];
  origins: SourceOrigin[];
  errors: string[];
};
