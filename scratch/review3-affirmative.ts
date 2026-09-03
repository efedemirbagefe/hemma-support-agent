import { isAffirmative } from "../src/domain/guards";
const cases = [
  "Is that correct?",
  "Wait, is that right?",
  "I cannot confirm that yet",
  "I can't confirm yet",
  "Which one did you say, Friday? Correct?",
  "tamam değil",
  "yok tamam istemem",
  "hold on, yes was for the other order",
  "let me think... do it? no wait",
  "Yes?",
  "confirm what exactly?",
  "I'd rather you didn't, yes I said that",
  "wait",
  "hmm, correct me if I'm wrong",
  "please don't",
];
for (const c of cases) console.log(String(isAffirmative(c)).padEnd(6), JSON.stringify(c));
