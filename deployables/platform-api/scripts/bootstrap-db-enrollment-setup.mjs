import { checkBootstrapDbEnrollment, formatBootstrapDbEnrollmentResult } from "./check-bootstrap-db-enrollment.mjs";

export default function setup() {
  const result = checkBootstrapDbEnrollment();
  const message = formatBootstrapDbEnrollmentResult(result);
  if (result.violations.length) throw new Error(message);
  console.log(message);
}
