import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  createFeeRule,
  FeeRuleError,
  listFeeRules,
  type CreateFeeRuleInput,
} from "@/server/finance/fee-rule-service";

// MFA is enforced inside requireSessionRole. assertSessionRole applies the operational-session
// challenge to every non-self-service role, so this surface is gated on the same choke point as the
// other platform_ops surfaces rather than on a check of its own.
const OPERATIONAL_ROLES = ["platform_ops"] as const;

const toErrorResponse = (error: unknown): NextResponse => {
  if (error instanceof FeeRuleError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }

  return toAccessDeniedResponse(error);
};

// Every amount arrives as a client-declared number and none of them are trusted: each is checked to
// be a non-negative safe integer here, and the service re-checks the whole set through the fee
// computation before anything is stored.
const readOptionalAmount = (value: unknown, field: string): number | null => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return readAmount(value, field);
};

const readAmount = (value: unknown, field: string): number => {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new FeeRuleError(
      "fee_rule_terms_invalid",
      `${field} must be a whole, non-negative amount in the currency's smallest unit`,
    );
  }

  return parsed;
};

const readDate = (value: unknown, field: string, optional: boolean): Date | null => {
  if (optional && (value === null || value === undefined || value === "")) {
    return null;
  }

  const parsed = new Date(String(value));

  if (Number.isNaN(parsed.getTime())) {
    throw new FeeRuleError("fee_rule_effective_window_invalid", `${field} is not a valid date`);
  }

  return parsed;
};

const toCreateInput = (body: unknown): CreateFeeRuleInput => {
  const payload = (body ?? {}) as Record<string, unknown>;
  const rawInstitutionId = payload.institutionId;
  const effectiveFrom = readDate(payload.effectiveFrom, "effectiveFrom", false);

  if (!effectiveFrom) {
    throw new FeeRuleError("fee_rule_effective_window_invalid", "effectiveFrom is required");
  }

  return {
    institutionId:
      typeof rawInstitutionId === "string" && rawInstitutionId.trim() !== ""
        ? rawInstitutionId.trim()
        : null,
    currency: typeof payload.currency === "string" ? payload.currency.trim().toUpperCase() : "",
    basisPoints: readAmount(payload.basisPoints, "basisPoints"),
    flatAmount: readAmount(payload.flatAmount ?? 0, "flatAmount"),
    minimumFeeAmount: readOptionalAmount(payload.minimumFeeAmount, "minimumFeeAmount"),
    maximumFeeAmount: readOptionalAmount(payload.maximumFeeAmount, "maximumFeeAmount"),
    effectiveFrom,
    effectiveTo: readDate(payload.effectiveTo, "effectiveTo", true),
  };
};

// List every fee rule. platform_ops only.
export async function GET(): Promise<Response> {
  try {
    await requireSessionRole(OPERATIONAL_ROLES);

    return NextResponse.json({ rules: await listFeeRules() }, { status: 200 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

// Record a new fee rule. platform_ops only. Rules are effective-dated, so there is no PATCH. A rate
// change is a new rule taking over from a date.
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireSessionRole(OPERATIONAL_ROLES);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const created = await createFeeRule(session.user.id, toCreateInput(body));

    return NextResponse.json({ rule: created }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
