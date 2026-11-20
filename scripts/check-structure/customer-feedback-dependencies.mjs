const customerFeedback = "@chase-sets/customer-feedback";
const allowedPublishers = new Set(["notifications", "platform-operations"]);

export function findCustomerFeedbackDependencyViolations(manifests) {
  return manifests.flatMap((manifest) =>
    !allowedPublishers.has(manifest.contextName) && manifest.allowedContextDependencies?.includes(customerFeedback)
      ? [`${manifest.contextName}: Customer Feedback must consume native facts, not be a publisher dependency`]
      : [],
  );
}
