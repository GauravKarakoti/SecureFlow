import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";

export enum ClearanceLevel {
  USER = 0,
  OPERATOR = 1,
  SECURITY_LEAD = 2,
  ADMIN = 3,
}

export type ClearanceLevelName = keyof typeof ClearanceLevel;

export class ClearanceError extends Error {
  public statusCode: number;
  public requiredClearance: ClearanceLevel;
  public currentClearance: ClearanceLevel | null;

  constructor(
    message: string,
    statusCode: number = 403,
    requiredClearance: ClearanceLevel = ClearanceLevel.OPERATOR,
    currentClearance: ClearanceLevel | null = null,
  ) {
    super(message);
    this.name = "ClearanceError";
    this.statusCode = statusCode;
    this.requiredClearance = requiredClearance;
    this.currentClearance = currentClearance;
  }
}

/**
 * Normalizes a clearance level name or enum into a numerical ClearanceLevel.
 */
export function parseClearanceLevel(
  level: ClearanceLevel | ClearanceLevelName | string | number | undefined,
): ClearanceLevel {
  if (typeof level === "number") {
    if (level in ClearanceLevel) {
      return level as ClearanceLevel;
    }
    return ClearanceLevel.USER;
  }

  if (typeof level === "string") {
    const upper = level.toUpperCase().trim();
    if (upper === "ADMIN") return ClearanceLevel.ADMIN;
    if (upper === "SECURITY_LEAD" || upper === "LEAD") return ClearanceLevel.SECURITY_LEAD;
    if (upper === "OPERATOR") return ClearanceLevel.OPERATOR;
    if (upper === "USER") return ClearanceLevel.USER;
  }

  return ClearanceLevel.USER;
}

/**
 * Resolves the effective clearance level of a NextAuth session.
 * Evaluates session.user.roles, session.user.clearance, and fallback properties.
 */
export function getUserClearance(
  session:
    | { user?: { id?: string; roles?: string[]; clearance?: string | ClearanceLevel } }
    | null
    | undefined,
): ClearanceLevel | null {
  if (!session?.user?.id) {
    return null;
  }

  let highest = ClearanceLevel.USER;

  // Check explicit clearance attribute if present
  if (session.user.clearance !== undefined) {
    const parsed = parseClearanceLevel(session.user.clearance);
    if (parsed > highest) highest = parsed;
  }

  // Check roles array from NextAuth session
  const roles = session.user.roles || [];
  for (const role of roles) {
    const parsed = parseClearanceLevel(role);
    if (parsed > highest) {
      highest = parsed;
    }
  }

  return highest;
}

/**
 * Checks if a session possesses at least the required clearance level.
 */
export function hasClearance(
  session:
    | { user?: { id?: string; roles?: string[]; clearance?: string | ClearanceLevel } }
    | null
    | undefined,
  required: ClearanceLevel | ClearanceLevelName = ClearanceLevel.OPERATOR,
): boolean {
  const userClearance = getUserClearance(session);
  if (userClearance === null) {
    return false;
  }

  const requiredLevel = parseClearanceLevel(required);
  return userClearance >= requiredLevel;
}

/**
 * Verifies operator clearance and returns an authorization result object.
 */
export function verifyOperatorClearance(
  session:
    | { user?: { id?: string; roles?: string[]; clearance?: string | ClearanceLevel } }
    | null
    | undefined,
  required: ClearanceLevel | ClearanceLevelName = ClearanceLevel.OPERATOR,
): {
  authorized: boolean;
  clearance: ClearanceLevel | null;
  requiredClearance: ClearanceLevel;
  reason?: string;
} {
  const requiredLevel = parseClearanceLevel(required);
  const currentClearance = getUserClearance(session);

  if (currentClearance === null) {
    return {
      authorized: false,
      clearance: null,
      requiredClearance: requiredLevel,
      reason: "Authentication required to verify operator clearance",
    };
  }

  if (currentClearance < requiredLevel) {
    const requiredName = ClearanceLevel[requiredLevel];
    const currentName = ClearanceLevel[currentClearance];
    return {
      authorized: false,
      clearance: currentClearance,
      requiredClearance: requiredLevel,
      reason: `Insufficient operator clearance. Required: ${requiredName} (${requiredLevel}), Current: ${currentName} (${currentClearance})`,
    };
  }

  return {
    authorized: true,
    clearance: currentClearance,
    requiredClearance: requiredLevel,
  };
}

/**
 * Asserts that a session satisfies the required clearance or throws a ClearanceError.
 */
export function requireOperatorClearance(
  session:
    | { user?: { id?: string; roles?: string[]; clearance?: string | ClearanceLevel } }
    | null
    | undefined,
  required: ClearanceLevel | ClearanceLevelName = ClearanceLevel.OPERATOR,
): asserts session is {
  user: { id: string; roles?: string[]; clearance?: string | ClearanceLevel };
} {
  const result = verifyOperatorClearance(session, required);
  if (!result.authorized) {
    const statusCode = result.clearance === null ? 401 : 403;
    throw new ClearanceError(
      result.reason || "Unauthorized action execution",
      statusCode,
      result.requiredClearance,
      result.clearance,
    );
  }
}

export interface ClearanceMiddlewareOptions {
  requiredClearance?: ClearanceLevel | ClearanceLevelName;
}

export interface ClearanceContext {
  session: any;
  clearance: ClearanceLevel;
  [key: string]: any;
}

/**
 * Next.js route handler middleware that enforces operator clearance before committing actions.
 */
export function withOperatorClearance(
  handler: (req: NextRequest, context: ClearanceContext) => Promise<NextResponse>,
  options: ClearanceMiddlewareOptions = {},
) {
  const required = options.requiredClearance ?? ClearanceLevel.OPERATOR;
  const requiredLevel = parseClearanceLevel(required);

  return async (req: NextRequest, routeContext?: any) => {
    let session = routeContext?.session;
    if (!session) {
      try {
        session = await auth();
      } catch (err) {
        return NextResponse.json(
          {
            error: "Authentication Failed",
            message: "Unable to retrieve user session",
          },
          { status: 401 },
        );
      }
    }

    const verification = verifyOperatorClearance(session, requiredLevel);

    if (!verification.authorized) {
      if (verification.clearance === null) {
        return NextResponse.json(
          {
            error: "Unauthorized",
            message: verification.reason || "Operator authentication required",
          },
          { status: 401 },
        );
      }

      return NextResponse.json(
        {
          error: "Forbidden",
          message: verification.reason || "Insufficient operator clearance",
          requiredClearance: ClearanceLevel[requiredLevel],
          currentClearance: ClearanceLevel[verification.clearance],
        },
        { status: 403 },
      );
    }

    const clearanceContext: ClearanceContext = {
      ...(routeContext || {}),
      session,
      clearance: verification.clearance!,
    };

    return handler(req, clearanceContext);
  };
}
