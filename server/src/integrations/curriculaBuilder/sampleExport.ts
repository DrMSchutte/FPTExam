import { Router } from "express";

// Block 7: a sample of the Curricula Builder export, served by FPT Exam itself
// when the Repl secret CURRICULA_BUILDER_MOCK=yes is set. It implements the
// contract (docs/curricula-builder-contract.md) exactly, so the whole route -
// list, pull, standard check, schedule, sit, mark - can be exercised before
// Curricula Builder's real export exists. Every title says SAMPLE. Remove the
// secret and it disappears; the two real secrets then take over.
//
// It also doubles as the reference implementation Curricula Builder copies:
// docs/curricula-builder-export-reference.md walks through this file.

export const SAMPLE_KEY = "sample";

const ELO_PAYROLL = [
  "ELO 1: Process payroll input, calculate gross-to-net pay and maintain accurate payroll records for a pay period.",
  "ELO 2: Apply statutory deductions and contributions (PAYE, UIF, SDL) correctly to employee remuneration.",
  "ELO 3: Complete and reconcile statutory returns and certificates (EMP201, EMP501, IRP5/IT3(a)) within the prescribed timeframes.",
  "ELO 4: Apply payroll controls, confidentiality and POPIA requirements to payroll information.",
];
const AC_PAYROLL = [
  "AC 1.1: Pro-rata and overtime calculations are performed correctly and shown.",
  "AC 1.2: Payroll records created for a new employee are complete and authorised.",
  "AC 2.1: PAYE, UIF and SDL are calculated on the correct remuneration base and at the correct rates.",
  "AC 2.2: Employer and employee contributions are distinguished.",
  "AC 3.1: The purpose, content and deadline of each statutory return is stated.",
  "AC 3.2: Reconciliation differences between EMP201 and EMP501 are identified and explained.",
  "AC 4.1: Payroll controls that prevent error and fraud are described and applied to a scenario.",
  "AC 4.2: POPIA obligations for payroll data are applied to a scenario.",
];

const payrollQuestions = (v: number) => [
  { id: "q1", type: "mcq", prompt: "Which of the following describes the UIF contribution on an employee's remuneration?", maxMark: 2, options: ["1% employee and 1% employer, each capped at the monthly ceiling", "2% employee only", "1% employer only", "2% employer, no employee contribution"], modelAnswerOrRubric: "1% employee and 1% employer, each capped at the monthly ceiling", eloRef: "ELO 2", acRef: "AC 2.2", bloomLevel: "remember" },
  { id: "q2", type: "short_answer", prompt: "An employee starts on the 11th of a 30-day month on a monthly salary of R27 000. Show the pro-rata salary for that month using calendar days, and state one other acceptable pro-rata basis.", maxMark: 6, modelAnswerOrRubric: "Days worked 20 of 30 (1); 27 000 × 20/30 = R18 000 (3); alternative basis: working days or hours in the month, applied consistently per the employer's policy (2).", eloRef: "ELO 1", acRef: "AC 1.1", bloomLevel: "apply" },
  { id: "q3", type: "long_answer", prompt: "A payroll clerk notices that the total PAYE on the EMP501 reconciliation for the tax year is R14 200 higher than the sum of the twelve EMP201 declarations. Explain three possible causes and, for each, the step you would take to resolve it before submission.", maxMark: 12, modelAnswerOrRubric: "Any three of: late-paid or back-dated remuneration processed after an EMP201 was filed (2 + 2 for the corrective step: revised EMP201 / declare in the correct period); an EMP201 filed with an understated PAYE figure (2 + 2: request correction of the declaration); IRP5 certificates issued for employees not included in an EMP201 (2 + 2: reconcile per employee, issue or cancel certificates); manual payments outside the payroll system (2 + 2: bring into payroll, re-run). Maximum 12.", eloRef: "ELO 3", acRef: "AC 3.2", bloomLevel: "analyse" },
  { id: "q4", type: "short_answer", prompt: "State the purpose of the IRP5 certificate and by when an employer must make it available to the employee after the end of the tax year.", maxMark: 4, modelAnswerOrRubric: "Purpose: employee tax certificate summarising remuneration and PAYE/UIF deducted for the year, used by the employee for the annual return (2). Timing: after the employer's annual EMP501 reconciliation, within the SARS reconciliation window (by 31 May) (2).", eloRef: "ELO 3", acRef: "AC 3.1", bloomLevel: "understand" },
  { id: "q5", type: "long_answer", prompt: "A small company with one payroll administrator has had two cases of overpayment in the past year. Describe four payroll controls you would put in place, and for each explain what error or fraud it prevents.", maxMark: 12, modelAnswerOrRubric: "Any four with the risk each addresses (3 each): master-file change approval by a second person (unauthorised rate or bank changes); pre-payment variance report reviewed and signed (overpayment, duplicate payments); reconciliation of headcount to HR records (ghost employees); segregation of input, approval and payment (single-person fraud); bank-file authorisation by two signatories; periodic audit of terminated employees still paid.", eloRef: "ELO 4", acRef: "AC 4.1", bloomLevel: "evaluate" },
  { id: "q6", type: "short_answer", prompt: v === 1 ? "A line manager asks the payroll administrator for the salary details of a colleague to 'settle an argument'. State what POPIA requires of the administrator and how the request should be handled." : "A line manager emails the payroll administrator asking for a spreadsheet of every employee's salary and ID number 'for planning'. State what POPIA requires and how the request should be handled, including what may be provided and to whom.", maxMark: 6, modelAnswerOrRubric: "Personal information may be processed only for the purpose collected and only by those who need it (2); the request is refused and the manager referred to HR / the information officer (2); the request is recorded; any aggregate or role-based information is provided only through the approved channel (2).", eloRef: "ELO 4", acRef: "AC 4.2", bloomLevel: "apply" },
];

const SAMPLE_QCTO_1 = {
  id: "cb-sample-payroll-eisa",
  title: "SAMPLE · EISA Paper 1 — Payroll Administrator",
  qualificationTitle: "Occupational Certificate: Payroll Administrator",
  kind: "qcto" as const,
  qctoRegistrationType: "eisa" as const,
  saqaQualificationId: "118706",
  nqfLevel: 5,
  version: "SAMPLE-2026-P1",
  updatedAt: "2026-09-01T09:00:00Z",
  timeAllocationMinutes: 150,
  permittedMaterials: ["Non-programmable calculator"],
  passMarkOrCompetencyRule: "50% overall",
  exitLevelOutcomes: ELO_PAYROLL,
  assessmentCriteria: AC_PAYROLL,
  questions: payrollQuestions(1),
};

// The same paper, re-released: shows the "new version" path on FPT Exam.
const SAMPLE_QCTO_1_V2 = { ...SAMPLE_QCTO_1, version: "SAMPLE-2026-P1-rev2", updatedAt: "2026-09-08T14:30:00Z", questions: payrollQuestions(2) };

const SAMPLE_QCTO_2 = {
  id: "cb-sample-bookkeeper-fisa",
  title: "SAMPLE · FISA — Bookkeeping to Trial Balance",
  qualificationTitle: "National Certificate: Bookkeeping",
  kind: "qcto" as const,
  qctoRegistrationType: "fisa" as const,
  saqaQualificationId: "58375",
  nqfLevel: 3,
  version: "SAMPLE-2026-A",
  updatedAt: "2026-08-20T10:00:00Z",
  timeAllocationMinutes: 120,
  permittedMaterials: ["Non-programmable calculator"],
  passMarkOrCompetencyRule: "50% overall",
  exitLevelOutcomes: [
    "ELO 1: Record source-document transactions in the books of prime entry.",
    "ELO 2: Post to the general ledger and extract a trial balance.",
    "ELO 3: Reconcile the bank statement to the cash book.",
  ],
  assessmentCriteria: ["AC 1.1: Transactions are recorded in the correct journal with the correct VAT treatment.", "AC 2.1: Ledger postings balance and the trial balance agrees.", "AC 3.1: Reconciling items are correctly identified and treated."],
  questions: [
    { id: "b1", type: "mcq", prompt: "A credit purchase of trading stock from a VAT vendor is first recorded in the:", maxMark: 2, options: ["Purchases journal", "Cash payments journal", "General journal", "Sales journal"], modelAnswerOrRubric: "Purchases journal", eloRef: "ELO 1", acRef: "AC 1.1", bloomLevel: "remember" },
    { id: "b2", type: "short_answer", prompt: "Goods are sold on credit for R2 300 including VAT at 15%. Show the amounts to be recorded for sales, VAT output and debtors control.", maxMark: 6, modelAnswerOrRubric: "Sales R2 000 (2); VAT output R300 (2); Debtors control R2 300 (2).", eloRef: "ELO 1", acRef: "AC 1.1", bloomLevel: "apply" },
    { id: "b3", type: "long_answer", prompt: "The cash book shows a closing balance of R18 450 (favourable). The bank statement shows R21 900. Outstanding deposits total R3 200; unpresented cheques total R6 100; bank charges of R450 appear only on the statement. Prepare the bank reconciliation statement and state the corrected cash book balance.", maxMark: 12, modelAnswerOrRubric: "Corrected cash book: 18 450 − 450 = R18 000 (3). Reconciliation: statement balance 21 900 + outstanding deposits 3 200 − unpresented cheques 6 100 = R19 000 … reconciles to corrected cash book only if a further R1 000 item is identified: award full marks for a correctly laid-out statement that shows the R1 000 unreconciled difference and states that it must be investigated (9).", eloRef: "ELO 3", acRef: "AC 3.1", bloomLevel: "analyse" },
    { id: "b4", type: "short_answer", prompt: "Explain what a trial balance proves and give two errors it does not detect.", maxMark: 6, modelAnswerOrRubric: "Proves arithmetical equality of debits and credits (2); does not detect errors of omission, commission, principle, compensating errors or original entry - any two (4).", eloRef: "ELO 2", acRef: "AC 2.1", bloomLevel: "understand" },
  ],
};

const SAMPLE_OTHER = {
  id: "cb-sample-cpd-popia",
  title: "SAMPLE · CPD Assessment — POPIA for Payroll Practitioners",
  qualificationTitle: "CPD: POPIA for Payroll Practitioners",
  kind: "other" as const,
  qctoRegistrationType: null,
  saqaQualificationId: null,
  nqfLevel: null,
  version: "SAMPLE-2026-1",
  updatedAt: "2026-08-30T08:00:00Z",
  timeAllocationMinutes: 45,
  permittedMaterials: [],
  passMarkOrCompetencyRule: "70% overall",
  exitLevelOutcomes: ["Outcome 1: Identify personal information and special personal information in payroll data.", "Outcome 2: Apply the eight conditions for lawful processing to payroll activities.", "Outcome 3: Respond correctly to a data-subject request and a suspected breach."],
  assessmentCriteria: [],
  questions: [
    { id: "p1", type: "mcq", prompt: "Which of these is special personal information under POPIA?", maxMark: 2, options: ["Bank account number", "Trade union membership", "Job title", "Employee number"], modelAnswerOrRubric: "Trade union membership", eloRef: "Outcome 1", bloomLevel: "remember" },
    { id: "p2", type: "short_answer", prompt: "Name four of the eight conditions for lawful processing and give a payroll example of each.", maxMark: 8, modelAnswerOrRubric: "Any four of accountability, processing limitation, purpose specification, further processing limitation, information quality, openness, security safeguards, data subject participation (1 each) with a relevant payroll example (1 each).", eloRef: "Outcome 2", bloomLevel: "understand" },
    { id: "p3", type: "long_answer", prompt: "A payroll file containing 300 employees' ID numbers and salaries is emailed to the wrong recipient. Describe the steps the organisation must take under POPIA, in order, and the timeframes that apply.", maxMark: 10, modelAnswerOrRubric: "Contain and assess (recall/confirm deletion) (2); notify the Information Regulator as soon as reasonably possible (2); notify affected data subjects unless identity cannot be established, with prescribed content (3); record the incident and remediate controls (2); involve the information officer throughout (1).", eloRef: "Outcome 3", bloomLevel: "apply" },
  ],
};

const ALL = [SAMPLE_QCTO_1, SAMPLE_QCTO_1_V2, SAMPLE_QCTO_2, SAMPLE_OTHER];

export const sampleExportRouter = Router();

// The contract's authentication: a bearer token FPT Exam holds.
sampleExportRouter.use((req, res, next) => {
  const expected = process.env.CURRICULA_BUILDER_API_KEY || SAMPLE_KEY;
  const header = req.get("authorization") ?? "";
  if (header !== `Bearer ${expected}`) return res.status(401).json({ error: "Unauthorised." });
  next();
});

const summary = (a: (typeof ALL)[number]) => ({ id: a.id, title: a.title, qualificationTitle: a.qualificationTitle, kind: a.kind, qctoRegistrationType: a.qctoRegistrationType, saqaQualificationId: a.saqaQualificationId, nqfLevel: a.nqfLevel, version: a.version, updatedAt: a.updatedAt });

// GET /api/exam-export/assessments?kind=qcto|other - released assessments only.
// Where several versions of one assessment are released, every version is listed.
sampleExportRouter.get("/assessments", (req, res) => {
  const kind = req.query.kind === "other" ? "other" : "qcto";
  res.json({ assessments: ALL.filter((a) => a.kind === kind).map(summary) });
});

// GET /api/exam-export/assessments/:id[?version=] - one assessment in full.
sampleExportRouter.get("/assessments/:id", (req, res) => {
  const matches = ALL.filter((a) => a.id === req.params.id);
  if (!matches.length) return res.status(404).json({ error: "No released assessment with that id." });
  const wanted = typeof req.query.version === "string" ? matches.find((a) => a.version === req.query.version) : null;
  // Without a version: the latest release.
  const a = wanted ?? matches.slice().sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))[0];
  res.json(a);
});

export const isSampleExportEnabled = () => /^(yes|true|1)$/i.test(process.env.CURRICULA_BUILDER_MOCK ?? "");
