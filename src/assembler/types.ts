import { Buffer } from 'buffer';

export type MacroInstanceInfo = {
  name: string;
  ordinal: number;
  callerFile?: string;
  callerLine?: number;
  callerMacro?: MacroInstanceInfo;
};

export type SourceOrigin = {
  file?: string;
  line: number;
  macroScope?: string;
  macroInstance?: MacroInstanceInfo;
};

export type PrintMessage = {
  text: string;
  origin?: SourceOrigin;
  lineIndex?: number;
};


export type AssembleResult = {
  success: boolean;
  output?: Buffer;
  map?: Record<number, number>;
  errors?: string[];
  warnings?: string[];
  printMessages?: PrintMessage[];
  labels?: Record<string, { addr: number; line: number; src?: string }>;
  consts?: Record<string, number>;
  constOrigins?: Record<string, { line: number; src?: string }>;
  dataLineSpans?: Record<number, { start: number; byteLength: number; unitBytes: number }>;
  origins?: SourceOrigin[];
};

export type AssembleWriteResult = {
  success: boolean;
  path?: string;
  errors?: string[];
  warnings?: string[];
  printMessages?: PrintMessage[];
  timeMs?: number;
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
  macroScope?: string;
  // Optional current address for location-counter expressions (e.g. '*')
  locationCounter?: number;
  // The originating source line (per-file) for better local-label matching; defaults to lineIndex when absent.
  originLine?: number;
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
