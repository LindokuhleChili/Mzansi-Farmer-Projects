/* audit-tamper-test.p - hash-chain checks on real ABL. ONLY for the throw-away scratch database (oe-run.ps1 -Action scratch-test):
   it edits an audit row directly to prove that GET /farm/audit/verify finds the change. Never run it against the farm db.
   1. parity: the ABL hash of a fixed string equals the Node (mock-pasoe/audit-chain.js) value
   2. the chain verifies after the contract run
   3. changing one Detail is reported as ROW_HASH_MISMATCH at that row; restoring it makes the chain verify again */
USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.ObjectModelParser.
DEFINE VARIABLE iStat AS INTEGER NO-UNDO.
DEFINE VARIABLE cResp AS LONGCHAR NO-UNDO.
DEFINE VARIABLE jo AS JsonObject NO-UNDO.
DEFINE VARIABLE cOld AS CHARACTER NO-UNDO.
DEFINE VARIABLE iId AS INTEGER NO-UNDO.
DEFINE VARIABLE iFail AS INTEGER NO-UNDO.
DEFINE VARIABLE cHash AS CHARACTER NO-UNDO.
DEFINE VARIABLE oP AS ObjectModelParser NO-UNDO.
IF NOT DBNAME MATCHES "*scratch*" THEN DO: MESSAGE "REFUSED: audit-tamper-test.p only runs on the scratch database". QUIT. END.

FUNCTION fVerify RETURNS JsonObject ():
    RUN farm-api.p ("GET", "/farm/audit/verify", "", OUTPUT iStat, OUTPUT cResp).
    oP = NEW ObjectModelParser().
    RETURN CAST(oP:Parse(cResp), JsonObject).
END FUNCTION.
PROCEDURE check:
    DEFINE INPUT PARAMETER pl AS LOGICAL NO-UNDO.
    DEFINE INPUT PARAMETER pc AS CHARACTER NO-UNDO.
    IF pl THEN MESSAGE "  PASS  " + pc. ELSE DO: MESSAGE "  FAIL  " + pc. iFail = iFail + 1. END.
END PROCEDURE.

cHash = LC(STRING(HEX-ENCODE(MESSAGE-DIGEST("SHA-256", '|1|2026-10-24T19:00:00.000Z|req_x|api|tool_call|~{"a":1}')))).
RUN check (cHash = "aeb50db958b482f63c424fc2823bcb07b867309f206ecf17e251ce2505923eb2", "AUD-T1 ABL SHA-256 equals the Node value (parity)").
jo = fVerify().
RUN check (jo:GetLogical("ok") AND jo:GetInteger("checked") > 0, "AUD-T2 chain verifies after the contract run (" + STRING(jo:GetInteger("checked")) + " rows)").
FIND FIRST AuditLog WHERE AuditLog.RowHash <> "" AND AuditLog.AuditId > 2 EXCLUSIVE-LOCK.
ASSIGN iId = AuditLog.AuditId cOld = AuditLog.Detail AuditLog.Detail = cOld + " (edited)".
RELEASE AuditLog.
jo = fVerify().
RUN check (NOT jo:GetLogical("ok") AND jo:GetInteger("firstBadId") = iId AND jo:GetCharacter("reason") = "ROW_HASH_MISMATCH", "AUD-T3 an edited Detail is reported at row " + STRING(iId)).
FIND AuditLog WHERE AuditLog.AuditId = iId EXCLUSIVE-LOCK. AuditLog.Detail = cOld. RELEASE AuditLog.
jo = fVerify().
RUN check (jo:GetLogical("ok"), "AUD-T4 restoring the row makes the chain verify again").
MESSAGE SUBSTITUTE("AUDIT TAMPER TEST DONE: &1 failed", iFail).
