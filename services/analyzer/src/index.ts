import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";

export interface ParsedFunction {
  id: string;
  name: string;
  path: string;
  line: number;
  column: number;
}

export interface ParsedClass {
  id: string;
  name: string;
  path: string;
  line: number;
  column: number;
}

export interface ParsedEndpoint {
  path: string;
  method: string;
  file: string;
}

export interface ParsedTest {
  name: string;
  path: string;
  file: string;
}

export interface Relationship {
  from: string;
  to: string;
  type: "IMPORTS" | "CALLS" | "DEFINES" | "TESTS" | "DEPENDS_ON";
}

export interface ParsedRepository {
  repositoryId: string;
  name: string;
  packages: any[];
  functions: ParsedFunction[];
  classes: ParsedClass[];
  endpoints: ParsedEndpoint[];
  tests: ParsedTest[];
  relationships: Relationship[];
}

function getAllSourceFiles(repoPath: string): string[] {
  const files: string[] = [];

  function walk(dir: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
          files.push(fullPath);
        }
      }
    } catch (e) {
      // skip unreadable dirs
    }
  }

  walk(repoPath);
  return files;
}

function extractImports(filePath: string): Relationship[] {
  const relations: Relationship[] = [];

  try {
    const source = fs.readFileSync(filePath, "utf-8");
    const file = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true
    );

    ts.forEachChild(file, (node) => {
      if (ts.isImportDeclaration(node)) {
        const moduleRef = node.moduleSpecifier;
        if (ts.isStringLiteral(moduleRef)) {
          relations.push({
            from: filePath,
            to: moduleRef.text,
            type: "IMPORTS",
          });
        } else if (node.importClause && "named" in node.importClause) {
          const namedBindings = (node.importClause as any).named;
          if (namedBindings && namedBindings.elements) {
            for (let i = 0; i < namedBindings.elements.length; i++) {
              const element = namedBindings.elements[i];
              if (element && element.name) {
                relations.push({
                  from: filePath,
                  to: element.name.text,
                  type: "IMPORTS",
                });
              }
            }
          }
        }
      }
    });
  } catch (e) {
    // silently skip
  }

  return relations;
}

function extractFunctionCallsFromFile(filePath: string): Relationship[] {
  const relations: Relationship[] = [];

  try {
    const source = fs.readFileSync(filePath, "utf-8");
    const file = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true
    );

    ts.forEachChild(file, (node) => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        if (ts.isIdentifier(expression)) {
          relations.push({
            from: filePath,
            to: expression.text,
            type: "CALLS",
          });
        }
      }
    });
  } catch (e) {
    // silently skip
  }

  return relations;
}

function parseFunctionsFromFile(filePath: string): ParsedFunction[] {
  const functions: ParsedFunction[] = [];

  try {
    const source = fs.readFileSync(filePath, "utf-8");
    const file = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true
    );

    ts.forEachChild(file, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        // @ts-ignore - pos properties vary by TS version
        const line = node.name.pos?.lineNumber ?? node.pos?.lineNumber ?? 1;
        // @ts-ignore - pos properties vary by TS version
        const column = node.name.pos?.columnNumber ?? node.pos?.columnNumber ?? 1;
        functions.push({
          id: crypto.randomUUID(),
          name: node.name.text,
          path: filePath,
          line: typeof line === "number" ? line : 1,
          column: typeof column === "number" ? column : 1,
        });
      }
    });
  } catch (e) {
    // skip
  }

  return functions;
}

function parseClassesFromFile(filePath: string): ParsedClass[] {
  const classes: ParsedClass[] = [];

  try {
    const source = fs.readFileSync(filePath, "utf-8");
    const file = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true
    );

    ts.forEachChild(file, (node) => {
      if (ts.isClassDeclaration(node) && node.name) {
        // @ts-ignore - pos properties vary by TS version
        const line = node.name.pos?.lineNumber ?? node.pos?.lineNumber ?? 1;
        // @ts-ignore - pos properties vary by TS version
        const column = node.name.pos?.columnNumber ?? node.pos?.columnNumber ?? 1;
        classes.push({
          id: crypto.randomUUID(),
          name: node.name.text,
          path: filePath,
          line: typeof line === "number" ? line : 1,
          column: typeof column === "number" ? column : 1,
        });
      }
    });
  } catch (e) {
    // skip
  }

  return classes;
}

function parseEndpointsFromFile(filePath: string): ParsedEndpoint[] {
  const endpoints: ParsedEndpoint[] = [];

  try {
    const source = fs.readFileSync(filePath, "utf-8");
    // Look for Express-style route definitions: method("path")
    const routeRegex = /(?:get|post|put|delete|patch)\(['"]\/[^'"]*['"]/gi;
    const matches = source.match(routeRegex);
    if (matches) {
      for (const match of matches) {
        const methodMatch = match.match(/^[a-z]+/i);
        const pathMatch = match.match(/'([^']+)'/);
        if (methodMatch && pathMatch) {
          endpoints.push({
            path: pathMatch[1],
            method: methodMatch[0].toUpperCase(),
            file: filePath,
          });
        }
      }
    }
  } catch (e) {
    // skip
  }

  return endpoints;
}

function parseTestsFromFile(filePath: string): ParsedTest[] {
  const tests: ParsedTest[] = [];

  try {
    const basename = path.basename(filePath);
    if (
      basename.endsWith(".test.ts") ||
      basename.endsWith(".test.js") ||
      basename.endsWith(".spec.ts") ||
      basename.endsWith(".spec.js")
    ) {
      tests.push({
        name: path.basename(basename, path.extname(basename)),
        path: filePath,
        file: filePath,
      });
    }
  } catch (e) {
    // skip
  }

  return tests;
}

export async function analyzeRepository(repoPath: string): Promise<ParsedRepository> {
  const repoName = path.basename(repoPath);
  const packageJsonPath = path.join(repoPath, "package.json");

  let packageJson: any;
  if (fs.existsSync(packageJsonPath)) {
    packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  } else {
    packageJson = { dependencies: {}, devDependencies: {} };
  }

  const packages: any[] = [
    {
      name: packageJson.name || repoName,
      version: packageJson.version || "0.0.0",
      path: repoPath,
    },
  ];

  const allFiles = getAllSourceFiles(repoPath);

  // Parse functions, classes, endpoints, and tests from each file in parallel
  const functionPromises = allFiles.map(parseFunctionsFromFile);
  const classPromises = allFiles.map(parseClassesFromFile);
  const endpointPromises = allFiles.map(parseEndpointsFromFile);
  const testPromises = allFiles.map(parseTestsFromFile);

  const functionResults = (await Promise.all(functionPromises)) as ParsedFunction[][];
  const classResults = (await Promise.all(classPromises)) as ParsedClass[][];
  const endpointResults = (await Promise.all(endpointPromises)) as ParsedEndpoint[][];
  const testResults = (await Promise.all(testPromises)) as ParsedTest[][];

  const functions: ParsedFunction[] = functionResults.flat() as ParsedFunction[];
  const classes: ParsedClass[] = classResults.flat() as ParsedClass[];
  const endpoints: ParsedEndpoint[] = endpointResults.flat() as ParsedEndpoint[];
  const tests: ParsedTest[] = testResults.flat() as ParsedTest[];

  const relationships: Relationship[] = [];

  // Extract imports from all files
  for (const file of allFiles) {
    const fileRelations = extractImports(file);
    relationships.push(...fileRelations);
  }

  // Extract function calls from all files
  for (const file of allFiles) {
    const fileRelations = extractFunctionCallsFromFile(file);
    relationships.push(...fileRelations);
  }

  return {
    repositoryId: crypto.randomUUID(),
    name: repoName,
    packages,
    functions,
    classes,
    endpoints,
    tests,
    relationships,
  };
}