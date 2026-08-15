import { A1_BROKER_CAPABILITIES } from "../../../../lib/broker/a1-contract";
import { a1Error, a1Json, admitA1Request } from "../../../../lib/broker/a1-http";

export const maxDuration = 10;

export async function GET(req: Request): Promise<Response> {
  try {
    await admitA1Request(req, false);
    return a1Json(A1_BROKER_CAPABILITIES);
  } catch (error) {
    return a1Error(error);
  }
}
