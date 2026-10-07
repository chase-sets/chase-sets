// The one landing FAQ list: the visible collapsed group on `/` and the home
// route's FAQPage JSON-LD both render from it, so the two can never drift.
// `value` is the bounded disclosure item identity; question/answer are locale
// keys (answers may interpolate the checkout-fee presentation values).
export const landingFaqEntries = [
  { value: "launch", question: "publicPresence.faq.launch.question", answer: "publicPresence.faq.launch.answer" },
  { value: "fees", question: "publicPresence.faq.fees.question", answer: "publicPresence.faq.fees.answer" },
  {
    value: "shipping",
    question: "publicPresence.faq.shipping.question",
    answer: "publicPresence.faq.shipping.answer",
  },
  { value: "safety", question: "publicPresence.faq.safety.question", answer: "publicPresence.faq.safety.answer" },
] as const;
