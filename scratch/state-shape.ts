/** Prints the exact keys the `state` WS event carries after the SessionSnapshot unification. */
import { Session } from "../src/domain/session";
import { snapshotSession } from "../src/voice/session-voice";

const s = new Session();
s.setLastUserUtterance("hi");
const snap = snapshotSession(s);
const wire = JSON.parse(JSON.stringify(snap));
console.log("state keys:", Object.keys(wire).join(","));
console.log("utteranceSeq:", snap.utteranceSeq, "proposals:", snap.proposals.length, "toolLog:", snap.toolLog.length);
