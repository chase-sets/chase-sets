// Deployable-facing UI surface. Other contexts' routes render the feedback
// prompt; the ./web surface keeps React out of the ./server barrel so the API
// composition root can import resolvers without evaluating UI code.
export { PlatformFeedbackPrompt } from "../../features/platform-feedback/ui/platform-feedback-prompt";
