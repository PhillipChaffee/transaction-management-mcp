import type { OpenAPIDocument, SchemaObject } from "./openapi-document.ts";
import { deref, isReferenceObject } from "./openapi-document.ts";

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteKey(key: string): string {
  return IDENT_RE.test(key) ? key : JSON.stringify(key);
}

function schemaTypes(schema: SchemaObject): string[] {
  if (Array.isArray(schema.type)) {
    return schema.type.map(String);
  }
  if (typeof schema.type === "string") {
    return [schema.type];
  }
  return [];
}

function isEmptyObjectSchema(schema: SchemaObject): boolean {
  const types = schemaTypes(schema);
  const isObject = types.length === 0 || types.includes("object");
  const propertyCount = schema.properties ? Object.keys(schema.properties).length : 0;
  return (
    isObject &&
    propertyCount === 0 &&
    !schema.items &&
    !schema.enum &&
    !schema.const &&
    !schema.allOf &&
    !schema.oneOf &&
    !schema.anyOf &&
    schema.additionalProperties === undefined
  );
}

function hasNoType(schema: SchemaObject): boolean {
  return (
    schemaTypes(schema).length === 0 &&
    !schema.properties &&
    !schema.items &&
    !schema.enum &&
    !schema.const &&
    !schema.allOf &&
    !schema.oneOf &&
    !schema.anyOf &&
    schema.additionalProperties === undefined
  );
}

export class ZodEmitter {
  private readonly document: OpenAPIDocument;
  private readonly stack = new Set<string>();

  public constructor(document: OpenAPIDocument) {
    this.document = document;
  }

  public emit(
    schema: SchemaObject | { $ref: string } | undefined,
    fallback = "z.unknown()",
  ): string {
    if (!schema) {
      return fallback;
    }
    if (isReferenceObject(schema)) {
      if (this.stack.has(schema.$ref)) {
        return "z.unknown()";
      }
      this.stack.add(schema.$ref);
      try {
        return this.emit(deref<SchemaObject>(this.document, schema), fallback);
      } finally {
        this.stack.delete(schema.$ref);
      }
    }
    return this.emitSchema(schema, fallback);
  }

  public emitOpenObject(): string {
    return "z.record(z.string(), z.unknown())";
  }

  public emitEmptyBody(): string {
    return this.emitOpenObject();
  }

  private emitSchema(schema: SchemaObject, fallback: string): string {
    if (schema.const !== undefined) {
      return `z.literal(${JSON.stringify(schema.const)})`;
    }

    if (schema.enum && schema.enum.length > 0) {
      const allStrings = schema.enum.every((value) => typeof value === "string");
      if (allStrings) {
        const literals = schema.enum.map((value) => JSON.stringify(value)).join(", ");
        return `z.enum([${literals}])`;
      }
      return `z.union([${schema.enum.map((value) => `z.literal(${JSON.stringify(value)})`).join(", ")}])`;
    }

    if (schema.allOf && schema.allOf.length > 0) {
      const parts = schema.allOf.map((part) => this.emit(part, fallback));
      if (parts.length === 1) {
        return parts[0] ?? fallback;
      }
      return parts.slice(1).reduce((acc, part) => `z.intersection(${acc}, ${part})`, parts[0]!);
    }

    if (schema.oneOf && schema.oneOf.length > 0) {
      return this.emitUnion(schema.oneOf, fallback);
    }
    if (schema.anyOf && schema.anyOf.length > 0) {
      return this.emitUnion(schema.anyOf, fallback);
    }

    if (hasNoType(schema)) {
      // Untyped / typeless nullable document payloads (e.g. CDA documentData).
      return schema.nullable === true ? "z.unknown().nullable()" : "z.unknown()";
    }

    const types = schemaTypes(schema).filter((type) => type !== "null");
    const nullable =
      schema.nullable === true ||
      schemaTypes(schema).includes("null") ||
      (Array.isArray(schema.type) && schema.type.includes("null"));

    let expression: string;
    if (types.length === 0) {
      expression = fallback;
    } else if (types.length === 1) {
      expression = this.emitTypedSchema(types[0]!, schema, fallback);
    } else {
      expression = `z.union([${types.map((type) => this.emitTypedSchema(type, schema, fallback)).join(", ")}])`;
    }

    if (isEmptyObjectSchema(schema) && types.includes("object")) {
      expression = this.emitOpenObject();
    }

    return nullable ? `${expression}.nullable()` : expression;
  }

  private emitUnion(members: Array<SchemaObject | { $ref: string }>, fallback: string): string {
    const parts = members.map((member) => this.emit(member, fallback));
    if (parts.length === 1) {
      return parts[0] ?? fallback;
    }
    return `z.union([${parts.join(", ")}])`;
  }

  private emitTypedSchema(type: string, schema: SchemaObject, fallback: string): string {
    switch (type) {
      case "string":
        return this.emitString(schema);
      case "integer":
      case "number":
        return type === "integer" ? "z.number().int()" : "z.number()";
      case "boolean":
        return "z.boolean()";
      case "array":
        return `z.array(${this.emit(schema.items, "z.unknown()")})`;
      case "object":
        return this.emitObject(schema);
      default:
        return fallback;
    }
  }

  private emitString(schema: SchemaObject): string {
    if (schema.format === "binary") {
      return "z.string()";
    }
    return "z.string()";
  }

  private emitObject(schema: SchemaObject): string {
    const properties = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const entries = Object.entries(properties).map(([name, propertySchema]) => {
      const emitted = this.emit(propertySchema, "z.unknown()");
      const optional = required.has(name) ? emitted : `${emitted}.optional()`;
      return `  ${quoteKey(name)}: ${optional}`;
    });

    if (entries.length === 0) {
      // Empty object + additionalProperties:false → reject unknown keys; otherwise open JSON.
      return schema.additionalProperties === false
        ? "z.object({}).strict()"
        : this.emitOpenObject();
    }

    let expression = `z.object({\n${entries.join(",\n")}\n})`;
    if (schema.additionalProperties === false) {
      expression = `${expression}.strict()`;
    } else if (schema.additionalProperties && schema.additionalProperties !== true) {
      expression = `${expression}.catchall(${this.emit(schema.additionalProperties, "z.unknown()")})`;
    }

    return expression;
  }
}
