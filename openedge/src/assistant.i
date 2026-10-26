/*------------------------------------------------------------------------
  assistant.i - Farm Assistant (docs/ASSISTANT.md), compiled as part of
  farm-api.p (included after doctor.i; uses fDrNorm, dr-check-text, ttDrBlk).
  Same behaviour as mock-pasoe/assistant.js.
  RAG: GuidePassage holds verbatim openly licensed guide excerpts. SearchText
  is the normalised text with a WORD index; search uses ABL CONTAINS, then
  scores 2 per question word (or its singular/plural) and 1 per synonym.
  RULES: CITATION_UNKNOWN (every cited passage id must exist), DOSE_BLOCKED
  (doctor.i) on every text, SUGGESTION_MISMATCH, USE_SUGGESTION_APPROVAL.
------------------------------------------------------------------------*/
&SCOPED-DEFINE GD_MAX_BASE 8
&SCOPED-DEFINE GD_MAX_TERMS 24
&SCOPED-DEFINE GD_MIN_LEN 3

DEFINE TEMP-TABLE ttGdHit NO-UNDO
    FIELD passageId AS INTEGER
    FIELD score     AS INTEGER
    INDEX idxRank score DESCENDING passageId.
DEFINE TEMP-TABLE ttGdId NO-UNDO
    FIELD id AS INTEGER
    INDEX idxId IS PRIMARY UNIQUE id.

FUNCTION fGdIsInt RETURNS LOGICAL (INPUT poJo AS JsonObject, INPUT pcName AS CHARACTER):
    DEFINE VARIABLE d AS DECIMAL NO-UNDO.
    IF NOT poJo:Has(pcName) OR poJo:GetType(pcName) <> JsonDataType:NUMBER THEN RETURN FALSE.
    d = poJo:GetDecimal(pcName).
    RETURN d = TRUNCATE(d, 0) AND ABSOLUTE(d) < 2000000000.
END FUNCTION.

/* 1 to piMax integers */
FUNCTION fGdIds RETURNS LOGICAL (INPUT poJo AS JsonObject, INPUT pcName AS CHARACTER, INPUT piMax AS INTEGER):
    DEFINE VARIABLE ja AS JsonArray NO-UNDO.
    DEFINE VARIABLE i AS INTEGER NO-UNDO.
    DEFINE VARIABLE d AS DECIMAL NO-UNDO.
    IF NOT poJo:Has(pcName) OR poJo:GetType(pcName) <> JsonDataType:ARRAY THEN RETURN FALSE.
    ja = poJo:GetJsonArray(pcName).
    IF ja:Length < 1 OR ja:Length > piMax THEN RETURN FALSE.
    DO i = 1 TO ja:Length:
        IF ja:GetType(i) <> JsonDataType:NUMBER THEN RETURN FALSE.
        d = ja:GetDecimal(i).
        IF d <> TRUNCATE(d, 0) OR ABSOLUTE(d) >= 2000000000 THEN RETURN FALSE.
    END.
    RETURN TRUE.
END FUNCTION.

FUNCTION fGdWordOk RETURNS LOGICAL (INPUT pc AS CHARACTER):
    DEFINE VARIABLE i AS INTEGER NO-UNDO.
    DEFINE VARIABLE a AS INTEGER NO-UNDO.
    IF pc = "" THEN RETURN FALSE.
    DO i = 1 TO LENGTH(pc):
        a = ASC(SUBSTRING(pc, i, 1)).
        IF NOT ((a >= 97 AND a <= 122) OR (a >= 48 AND a <= 57)) THEN RETURN FALSE.
    END.
    RETURN TRUE.
END FUNCTION.

/* question -> base words (with singular/plural form) and all terms (base + synonyms), comma lists */
PROCEDURE gd-terms:
    DEFINE INPUT  PARAMETER pcQ     AS CHARACTER NO-UNDO.
    DEFINE OUTPUT PARAMETER pcBase  AS CHARACTER NO-UNDO.
    DEFINE OUTPUT PARAMETER pcTerms AS CHARACTER NO-UNDO.
    DEFINE BUFFER bSy FOR GuideSynonym.
    DEFINE VARIABLE cN AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cWords AS CHARACTER NO-UNDO.
    DEFINE VARIABLE w AS CHARACTER NO-UNDO.
    DEFINE VARIABLE f AS CHARACTER NO-UNDO.
    DEFINE VARIABLE i AS INTEGER NO-UNDO.
    DEFINE VARIABLE k AS INTEGER NO-UNDO.
    DEFINE VARIABLE nW AS INTEGER NO-UNDO.
    cN = TRIM(fDrNorm(pcQ)).
    DO i = 1 TO NUM-ENTRIES(cN, " "):
        w = ENTRY(i, cN, " ").
        IF NOT fGdWordOk(w) OR LENGTH(w) < {&GD_MIN_LEN} THEN NEXT.
        IF CAN-FIND(GuideStopword WHERE GuideStopword.Word = w) THEN NEXT.
        IF LOOKUP(w, cWords) > 0 THEN NEXT.
        cWords = cWords + (IF cWords = "" THEN "" ELSE ",") + w.
        nW = nW + 1.
        IF nW >= {&GD_MAX_BASE} THEN LEAVE.
    END.
    DO i = 1 TO NUM-ENTRIES(cWords):
        IF cWords = "" THEN LEAVE.
        w = ENTRY(i, cWords).
        IF LOOKUP(w, pcBase) = 0 THEN pcBase = pcBase + (IF pcBase = "" THEN "" ELSE ",") + w.
        IF SUBSTRING(w, LENGTH(w), 1) = "s" THEN f = (IF LENGTH(w) > {&GD_MIN_LEN} THEN SUBSTRING(w, 1, LENGTH(w) - 1) ELSE "").
        ELSE f = w + "s".
        IF f <> "" AND LOOKUP(f, pcBase) = 0 THEN pcBase = pcBase + "," + f.
    END.
    pcTerms = pcBase.
    DO i = 1 TO NUM-ENTRIES(cWords):
        IF cWords = "" THEN LEAVE.
        FIND bSy WHERE bSy.SynTerm = ENTRY(i, cWords) NO-LOCK NO-ERROR.
        IF NOT AVAILABLE bSy THEN NEXT.
        DO k = 1 TO NUM-ENTRIES(bSy.Words, " "):
            w = ENTRY(k, bSy.Words, " ").
            IF w = "" OR LOOKUP(w, pcTerms) > 0 OR NUM-ENTRIES(pcTerms) >= {&GD_MAX_TERMS} THEN NEXT.
            pcTerms = pcTerms + (IF pcTerms = "" THEN "" ELSE ",") + w.
        END.
    END.
END PROCEDURE.

FUNCTION fGdPassageJson RETURNS JsonObject (INPUT piId AS INTEGER, INPUT plFull AS LOGICAL):
    DEFINE BUFFER bP FOR GuidePassage.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    FIND bP WHERE bP.PassageId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bP THEN RETURN ?.
    jo = NEW JsonObject().
    jo:Add("passageId", bP.PassageId).
    jo:Add("sourceTitle", bP.SourceTitle).
    jo:Add("section", bP.Section).
    IF plFull THEN jo:Add("crop", bP.Crop).
    jo:Add("licence", bP.Licence).
    jo:Add("sourceUrl", bP.SourceUrl).
    IF plFull THEN jo:Add("text", bP.PassageText).
    RETURN jo.
END FUNCTION.

/* POST /farm/guide/search {q, limit?} */
PROCEDURE h-gd-search:
    DEFINE VARIABLE cQ AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cBase AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cTerms AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cExpr AS CHARACTER NO-UNDO.
    DEFINE VARIABLE iLim AS INTEGER NO-UNDO INITIAL 3.
    DEFINE VARIABLE iSc AS INTEGER NO-UNDO.
    DEFINE VARIABLE i AS INTEGER NO-UNDO.
    DEFINE VARIABLE iCnt AS INTEGER NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE VARIABLE jp AS JsonObject NO-UNDO.
    DEFINE VARIABLE ja AS JsonArray NO-UNDO.
    DEFINE VARIABLE jt AS JsonArray NO-UNDO.
    DEFINE BUFFER bP FOR GuidePassage.
    IF NOT fDrStr(goBody, "q", 2, 200) THEN DO: RUN reply-error (400, "VALIDATION_ERROR", "q must be 2 to 200 characters.", "q"). RETURN. END.
    cQ = goBody:GetCharacter("q").
    IF goBody:Has("limit") THEN DO:
        IF NOT fGdIsInt(goBody, "limit") OR goBody:GetDecimal("limit") < 1 OR goBody:GetDecimal("limit") > 10 THEN DO:
            RUN reply-error (400, "VALIDATION_ERROR", "limit must be 1 to 10.", "limit"). RETURN. END.
        iLim = INTEGER(goBody:GetDecimal("limit")).
    END.
    RUN gd-terms (cQ, OUTPUT cBase, OUTPUT cTerms).
    EMPTY TEMP-TABLE ttGdHit.
    IF cTerms <> "" THEN DO:
        cExpr = REPLACE(cTerms, ",", " | ").
        FOR EACH bP NO-LOCK WHERE bP.SearchText CONTAINS cExpr:
            iSc = 0.
            DO i = 1 TO NUM-ENTRIES(cTerms):
                IF INDEX(bP.SearchText, " " + ENTRY(i, cTerms) + " ") > 0 THEN iSc = iSc + (IF LOOKUP(ENTRY(i, cTerms), cBase) > 0 THEN 2 ELSE 1).
            END.
            IF iSc > 0 THEN DO: CREATE ttGdHit. ASSIGN ttGdHit.passageId = bP.PassageId ttGdHit.score = iSc. END.
        END.
    END.
    jt = NEW JsonArray().
    DO i = 1 TO NUM-ENTRIES(cTerms):
        IF cTerms = "" THEN LEAVE.
        jt:Add(ENTRY(i, cTerms)).
    END.
    ja = NEW JsonArray().
    FOR EACH ttGdHit USE-INDEX idxRank:
        iCnt = iCnt + 1.
        IF iCnt > iLim THEN LEAVE.
        jp = fGdPassageJson(ttGdHit.passageId, TRUE).
        jp:Add("score", ttGdHit.score).
        ja:Add(jp).
    END.
    jo = NEW JsonObject().
    jo:Add("query", cQ).
    jo:Add("terms", jt).
    jo:Add("passages", ja).
    RUN reply (200, jo).
END PROCEDURE.

/* fills ttGdId with the ids of pcList (comma list) that are NOT in GuidePassage */
PROCEDURE gd-unknown:
    DEFINE INPUT PARAMETER pcList AS CHARACTER NO-UNDO.
    DEFINE VARIABLE i AS INTEGER NO-UNDO.
    DEFINE VARIABLE iId AS INTEGER NO-UNDO.
    EMPTY TEMP-TABLE ttGdId.
    DO i = 1 TO NUM-ENTRIES(pcList):
        IF pcList = "" THEN LEAVE.
        iId = INTEGER(ENTRY(i, pcList)).
        IF CAN-FIND(GuidePassage WHERE GuidePassage.PassageId = iId) THEN NEXT.
        IF CAN-FIND(ttGdId WHERE ttGdId.id = iId) THEN NEXT.
        CREATE ttGdId. ttGdId.id = iId.
    END.
END PROCEDURE.
FUNCTION fGdUnknownJson RETURNS JsonArray ():
    DEFINE VARIABLE ja AS JsonArray NO-UNDO.
    ja = NEW JsonArray().
    FOR EACH ttGdId BY ttGdId.id: ja:Add(ttGdId.id). END.
    RETURN ja.
END FUNCTION.
FUNCTION fGdIdList RETURNS CHARACTER (INPUT ja AS JsonArray):
    DEFINE VARIABLE c AS CHARACTER NO-UNDO.
    DEFINE VARIABLE i AS INTEGER NO-UNDO.
    DO i = 1 TO ja:Length: c = c + (IF c = "" THEN "" ELSE ",") + STRING(INTEGER(ja:GetDecimal(i))). END.
    RETURN c.
END FUNCTION.

/* POST /farm/guide/verify {citations:[...]} - the rule alone, writes nothing */
PROCEDURE h-gd-verify:
    DEFINE VARIABLE ja AS JsonArray NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE VARIABLE i AS INTEGER NO-UNDO.
    DEFINE VARIABLE d AS DECIMAL NO-UNDO.
    IF NOT goBody:Has("citations") OR goBody:GetType("citations") <> JsonDataType:ARRAY THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "citations must be at most 50 passage ids.", "citations"). RETURN. END.
    ja = goBody:GetJsonArray("citations").
    IF ja:Length > 50 THEN DO: RUN reply-error (400, "VALIDATION_ERROR", "citations must be at most 50 passage ids.", "citations"). RETURN. END.
    DO i = 1 TO ja:Length:
        IF ja:GetType(i) <> JsonDataType:NUMBER THEN DO: RUN reply-error (400, "VALIDATION_ERROR", "citations must be at most 50 passage ids.", "citations"). RETURN. END.
        d = ja:GetDecimal(i).
        IF d <> TRUNCATE(d, 0) OR ABSOLUTE(d) >= 2000000000 THEN DO: RUN reply-error (400, "VALIDATION_ERROR", "citations must be at most 50 passage ids.", "citations"). RETURN. END.
    END.
    RUN gd-unknown (fGdIdList(ja)).
    jo = NEW JsonObject().
    jo:Add("verdict", (IF CAN-FIND(FIRST ttGdId) THEN "blocked" ELSE "passed")).
    jo:Add("unknown", fGdUnknownJson()).
    RUN reply (200, jo).
END PROCEDURE.

PROCEDURE h-gd-passage:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    IF piId = ? OR NOT CAN-FIND(GuidePassage WHERE GuidePassage.PassageId = piId) THEN DO:
        RUN reply-error (404, "PASSAGE_NOT_FOUND", SUBSTITUTE("No guide passage with id &1.", (IF piId = ? THEN "?" ELSE STRING(piId))), ?). RETURN. END.
    RUN reply (200, fGdPassageJson(piId, TRUE)).
END PROCEDURE.

/* ---------- memory ---------- */
PROCEDURE h-as-memory:
    DEFINE VARIABLE iFarm AS INTEGER NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE VARIABLE jm AS JsonObject NO-UNDO.
    DEFINE VARIABLE ja AS JsonArray NO-UNDO.
    DEFINE BUFFER bM FOR FarmerMemory.
    iFarm = INTEGER(fQuery("farmId")) NO-ERROR.
    IF ERROR-STATUS:ERROR OR iFarm = ? THEN iFarm = 1.
    ja = NEW JsonArray().
    FOR EACH bM NO-LOCK WHERE bM.FarmId = iFarm BY bM.MemKey:
        jm = NEW JsonObject().
        jm:Add("key", bM.MemKey). jm:Add("value", bM.MemValue).
        IF bM.UpdatedAt = ? THEN jm:AddNull("updatedAt"). ELSE jm:Add("updatedAt", fIso(bM.UpdatedAt)).
        ja:Add(jm).
    END.
    jo = NEW JsonObject().
    jo:Add("farmId", iFarm).
    jo:Add("items", ja).
    RUN reply (200, jo).
END PROCEDURE.

PROCEDURE h-as-memory-save:
    DEFINE VARIABLE iFarm AS INTEGER NO-UNDO.
    DEFINE VARIABLE cKey AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cVal AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cReq AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cAct AS CHARACTER NO-UNDO.
    DEFINE VARIABLE lOk AS LOGICAL NO-UNDO.
    DEFINE VARIABLE i AS INTEGER NO-UNDO.
    DEFINE VARIABLE a AS INTEGER NO-UNDO.
    DEFINE VARIABLE iAud AS INTEGER NO-UNDO.
    DEFINE VARIABLE tNow AS DATETIME-TZ NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE BUFFER bM FOR FarmerMemory.
    IF NOT fGdIsInt(goBody, "farmId") THEN DO: RUN reply-error (400, "VALIDATION_ERROR", "farmId must be an integer.", "farmId"). RETURN. END.
    iFarm = INTEGER(goBody:GetDecimal("farmId")).
    RUN get-str (goBody, "key", OUTPUT cKey, OUTPUT lOk).
    IF lOk THEN lOk = LENGTH(cKey) >= 1 AND LENGTH(cKey) <= 40.
    IF lOk THEN DO i = 1 TO LENGTH(cKey):
        a = ASC(SUBSTRING(cKey, i, 1)).
        IF NOT ((a >= 97 AND a <= 122) OR (i > 1 AND ((a >= 48 AND a <= 57) OR a = 95))) THEN DO: lOk = FALSE. LEAVE. END.
    END.
    IF NOT lOk THEN DO: RUN reply-error (400, "VALIDATION_ERROR", "key must be 1 to 40 lower-case letters, digits or _.", "key"). RETURN. END.
    IF NOT fDrStr(goBody, "value", 1, 300) THEN DO: RUN reply-error (400, "VALIDATION_ERROR", "value is required (at most 300 characters).", "value"). RETURN. END.
    cVal = goBody:GetCharacter("value").
    IF NOT CAN-FIND(Farm WHERE Farm.FarmId = iFarm) THEN DO: RUN reply-error (404, "FARM_NOT_FOUND", SUBSTITUTE("No farm with id &1.", iFarm), "farmId"). RETURN. END.
    EMPTY TEMP-TABLE ttDrBlk. giDrSeq = 0.
    RUN dr-check-text ("value", cVal).
    IF CAN-FIND(FIRST ttDrBlk) THEN DO:
        jo = NEW JsonObject().
        jo:Add("error", "DOSE_BLOCKED").
        jo:Add("message", "The answer gives a chemical dose. Doses are never shown; ask an extension officer.").
        jo:Add("blocked", fDrBlockedJson()).
        RUN reply (422, jo). RETURN.
    END.
    RUN get-str (goBody, "requestId", OUTPUT cReq, OUTPUT lOk). IF NOT lOk THEN cReq = "".
    RUN get-str (goBody, "actor", OUTPUT cAct, OUTPUT lOk). IF NOT lOk OR TRIM(cAct) = "" THEN cAct = "farmer".
    tNow = NOW.
    DO TRANSACTION:
        FIND bM WHERE bM.FarmId = iFarm AND bM.MemKey = cKey EXCLUSIVE-LOCK NO-ERROR.
        IF NOT AVAILABLE bM THEN DO:
            CREATE bM.
            ASSIGN bM.MemoryId = NEXT-VALUE(MemorySeq) bM.FarmId = iFarm bM.MemKey = cKey.
        END.
        ASSIGN bM.MemValue = TRIM(cVal) bM.UpdatedAt = tNow.
        jo = NEW JsonObject().
        jo:Add("key", bM.MemKey). jo:Add("value", bM.MemValue). jo:Add("updatedAt", fIso(bM.UpdatedAt)).
        RELEASE bM.
    END.
    RUN audit (cReq, SUBSTRING(cAct, 1, 40), "assistant_memory_saved", SUBSTITUTE('~{"farmId":&1,"key":"&2"}', iFarm, cKey), tNow, OUTPUT iAud).
    RUN reply (200, jo).
END PROCEDURE.

/* ---------- case files ---------- */
FUNCTION fAsCaseJson RETURNS JsonObject (INPUT piId AS INTEGER):
    DEFINE BUFFER bC FOR AssistantCase.
    DEFINE BUFFER bF FOR CaseFollowUp.
    DEFINE BUFFER bS FOR AiSuggestion.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE VARIABLE jA AS JsonArray NO-UNDO.
    DEFINE VARIABLE jOut AS JsonArray NO-UNDO.
    DEFINE VARIABLE jCit AS JsonArray NO-UNDO.
    DEFINE VARIABLE jCc AS JsonArray NO-UNDO.
    DEFINE VARIABLE jFu AS JsonArray NO-UNDO.
    DEFINE VARIABLE jX AS JsonObject NO-UNDO.
    DEFINE VARIABLE jY AS JsonObject NO-UNDO.
    DEFINE VARIABLE jIds AS JsonArray NO-UNDO.
    DEFINE VARIABLE oP AS ObjectModelParser NO-UNDO.
    DEFINE VARIABLE cIds AS CHARACTER NO-UNDO.
    DEFINE VARIABLE i AS INTEGER NO-UNDO.
    DEFINE VARIABLE k AS INTEGER NO-UNDO.
    DEFINE VARIABLE iSg AS INTEGER NO-UNDO.
    FIND bC WHERE bC.CaseId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bC THEN RETURN ?.
    oP = NEW ObjectModelParser().
    jo = NEW JsonObject().
    jo:Add("caseId", bC.CaseId).
    jo:Add("createdAt", fIso(bC.CreatedAt)).
    jo:Add("plotId", bC.PlotId).
    jo:Add("problemType", bC.ProblemType).
    jo:Add("title", bC.CaseTitle).
    jo:Add("likelyCause", bC.LikelyCause).
    jo:Add("confidence", bC.Confidence).
    jCc = NEW JsonArray().
    cIds = bC.CauseCitations.
    DO i = 1 TO NUM-ENTRIES(bC.CauseCitations):
        IF bC.CauseCitations = "" THEN LEAVE.
        jCc:Add(INTEGER(ENTRY(i, bC.CauseCitations))).
    END.
    jo:Add("causeCitations", jCc).
    jA = CAST(oP:Parse(bC.ActionsJson), JsonArray).
    DO i = 1 TO jA:Length:
        jIds = jA:GetJsonObject(i):GetJsonArray("citations").
        DO k = 1 TO jIds:Length:
            IF LOOKUP(STRING(jIds:GetInteger(k)), cIds) = 0 THEN cIds = cIds + (IF cIds = "" THEN "" ELSE ",") + STRING(jIds:GetInteger(k)).
        END.
    END.
    jCit = NEW JsonArray().
    DO i = 1 TO NUM-ENTRIES(cIds):
        IF cIds = "" THEN LEAVE.
        jX = fGdPassageJson(INTEGER(ENTRY(i, cIds)), FALSE).
        IF jX <> ? THEN jCit:Add(jX).
    END.
    jo:Add("citations", jCit).
    jo:Add("evidence", CAST(oP:Parse(bC.EvidenceJson), JsonArray)).
    jOut = NEW JsonArray().
    DO i = 1 TO jA:Length:
        jX = jA:GetJsonObject(i).
        jY = NEW JsonObject().
        jY:Add("actionNo", jX:GetInteger("actionNo")).
        jY:Add("kind", jX:GetCharacter("kind")).
        jY:Add("text", jX:GetCharacter("text")).
        jY:Add("cost", jX:GetCharacter("cost")).
        jY:Add("citations", jX:GetJsonArray("citations")).
        iSg = jX:GetInteger("suggestionId").
        IF iSg > 0 THEN FIND bS WHERE bS.SuggestionId = iSg NO-LOCK NO-ERROR.
        IF iSg > 0 AND AVAILABLE bS THEN DO:
            jY:Add("suggestionId", iSg).
            jY:Add("verdict", bS.Verdict).
            jY:Add("status", bS.SuggStatus).
            IF bS.DecidedAt = ? THEN jY:AddNull("decidedAt"). ELSE jY:Add("decidedAt", fIso(bS.DecidedAt)).
        END.
        ELSE DO:
            jY:AddNull("suggestionId").
            jY:AddNull("verdict").
            jY:Add("status", jX:GetCharacter("status")).
            IF jX:GetType("decidedAt") = JsonDataType:NULL THEN jY:AddNull("decidedAt"). ELSE jY:Add("decidedAt", jX:GetCharacter("decidedAt")).
        END.
        jOut:Add(jY).
    END.
    jo:Add("actions", jOut).
    jFu = NEW JsonArray().
    FOR EACH bF NO-LOCK WHERE bF.CaseId = bC.CaseId BY bF.FollowUpId:
        jX = NEW JsonObject().
        jX:Add("followUpId", bF.FollowUpId).
        jX:Add("dueAt", fIso(bF.DueAt)).
        jX:Add("question", bF.Question).
        jX:Add("status", bF.FuStatus).
        jX:Add("answer", bF.Answer).
        IF bF.AnsweredAt = ? THEN jX:AddNull("answeredAt"). ELSE jX:Add("answeredAt", fIso(bF.AnsweredAt)).
        jFu:Add(jX).
    END.
    jo:Add("followUps", jFu).
    IF bC.DiagnosisId > 0 THEN jo:Add("diagnosisId", bC.DiagnosisId). ELSE jo:AddNull("diagnosisId").
    jo:Add("usedFallback", bC.UsedFallback).
    jo:Add("provider", bC.Provider).
    jo:Add("status", bC.CaseStatus).
    IF bC.ClosedAt = ? THEN jo:AddNull("closedAt"). ELSE jo:Add("closedAt", fIso(bC.ClosedAt)).
    RETURN jo.
END FUNCTION.

/* GET /farm/assistant/cases?status=&limit= */
PROCEDURE h-as-cases:
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE VARIABLE ja AS JsonArray NO-UNDO.
    DEFINE VARIABLE cSt AS CHARACTER NO-UNDO.
    DEFINE VARIABLE iLim AS INTEGER NO-UNDO.
    DEFINE VARIABLE iCnt AS INTEGER NO-UNDO.
    DEFINE BUFFER bC FOR AssistantCase.
    cSt = fQuery("status").
    iLim = INTEGER(fQuery("limit")) NO-ERROR.
    IF ERROR-STATUS:ERROR OR iLim = ? OR iLim < 1 THEN iLim = 20.
    IF iLim > 100 THEN iLim = 100.
    ja = NEW JsonArray().
    FOR EACH bC NO-LOCK BY bC.CaseId DESCENDING:
        IF cSt <> ? AND cSt <> "" AND bC.CaseStatus <> cSt THEN NEXT.
        iCnt = iCnt + 1.
        IF iCnt > iLim THEN LEAVE.
        ja:Add(fAsCaseJson(bC.CaseId)).
    END.
    jo = NEW JsonObject().
    jo:Add("cases", ja).
    RUN reply (200, jo).
END PROCEDURE.

PROCEDURE h-as-case:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    IF piId = ? OR NOT CAN-FIND(AssistantCase WHERE AssistantCase.CaseId = piId) THEN DO:
        RUN reply-error (404, "CASE_NOT_FOUND", SUBSTITUTE("No case with id &1.", (IF piId = ? THEN "?" ELSE STRING(piId))), ?). RETURN. END.
    RUN reply (200, fAsCaseJson(piId)).
END PROCEDURE.

/* POST /farm/assistant/cases - same order of checks as caseProblem() in mock-pasoe/assistant.js */
PROCEDURE h-as-case-create:
    DEFINE VARIABLE cBad AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cMsg AS CHARACTER NO-UNDO.
    DEFINE VARIABLE jE AS JsonArray NO-UNDO.
    DEFINE VARIABLE jA AS JsonArray NO-UNDO.
    DEFINE VARIABLE jX AS JsonObject NO-UNDO.
    DEFINE VARIABLE jStore AS JsonArray NO-UNDO.
    DEFINE VARIABLE jS AS JsonObject NO-UNDO.
    DEFINE VARIABLE jEv AS JsonArray NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE VARIABLE i AS INTEGER NO-UNDO.
    DEFINE VARIABLE iPlot AS INTEGER NO-UNDO.
    DEFINE VARIABLE iSg AS INTEGER NO-UNDO.
    DEFINE VARIABLE iDays AS INTEGER NO-UNDO.
    DEFINE VARIABLE iDiag AS INTEGER NO-UNDO.
    DEFINE VARIABLE iNew AS INTEGER NO-UNDO.
    DEFINE VARIABLE iAud AS INTEGER NO-UNDO.
    DEFINE VARIABLE cAllIds AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cReq AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cProv AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cKind AS CHARACTER NO-UNDO.
    DEFINE VARIABLE lOk AS LOGICAL NO-UNDO.
    DEFINE VARIABLE tNow AS DATETIME-TZ NO-UNDO.
    DEFINE VARIABLE cCosts AS CHARACTER NO-UNDO INITIAL "free,low,medium,high".
    DEFINE BUFFER bS FOR AiSuggestion.

    IF NOT fGdIsInt(goBody, "plotId") THEN ASSIGN cBad = "plotId" cMsg = "plotId must be an integer.".
    ELSE IF NOT fDrStr(goBody, "problemType", 1, 20) OR NOT fDrIn(goBody:GetCharacter("problemType"), "dry_soil,sick_plant,frost,heat") THEN ASSIGN cBad = "problemType" cMsg = "problemType must be one of dry_soil, sick_plant, frost, heat.".
    ELSE IF NOT fDrStr(goBody, "title", 1, 120) THEN ASSIGN cBad = "title" cMsg = "title is required (at most 120 characters).".
    ELSE IF NOT fDrStr(goBody, "likelyCause", 1, 400) THEN ASSIGN cBad = "likelyCause" cMsg = "likelyCause is required (at most 400 characters).".
    ELSE IF NOT goBody:Has("confidence") OR goBody:GetType("confidence") <> JsonDataType:STRING OR NOT fDrIn(goBody:GetCharacter("confidence"), "low,medium,high") THEN ASSIGN cBad = "confidence" cMsg = "confidence must be low, medium or high.".
    ELSE IF NOT fGdIds(goBody, "causeCitations", 5) THEN ASSIGN cBad = "causeCitations" cMsg = "causeCitations must be 1 to 5 passage ids.".
    ELSE IF NOT goBody:Has("evidence") OR goBody:GetType("evidence") <> JsonDataType:ARRAY OR goBody:GetJsonArray("evidence"):Length < 1 OR goBody:GetJsonArray("evidence"):Length > 12 THEN ASSIGN cBad = "evidence" cMsg = "evidence must be 1 to 12 items.".
    IF cBad = "" THEN DO:
        jE = goBody:GetJsonArray("evidence").
        DO i = 1 TO jE:Length:
            IF jE:GetType(i) <> JsonDataType:OBJECT THEN lOk = FALSE.
            ELSE lOk = fDrStr(jE:GetJsonObject(i), "kind", 1, 30) AND fDrStr(jE:GetJsonObject(i), "text", 1, 300).
            IF NOT lOk THEN DO: ASSIGN cBad = SUBSTITUTE("evidence[&1]", i - 1) cMsg = "Each evidence item needs kind (30) and text (300).". LEAVE. END.
        END.
    END.
    IF cBad = "" THEN DO:
        IF NOT goBody:Has("actions") OR goBody:GetType("actions") <> JsonDataType:ARRAY OR goBody:GetJsonArray("actions"):Length < 1 OR goBody:GetJsonArray("actions"):Length > 5 THEN
            ASSIGN cBad = "actions" cMsg = "actions must be 1 to 5 items.".
        ELSE DO:
            jA = goBody:GetJsonArray("actions").
            DO i = 1 TO jA:Length:
                IF jA:GetType(i) <> JsonDataType:OBJECT THEN DO: ASSIGN cBad = SUBSTITUTE("actions[&1].kind", i - 1) cMsg = "kind must be one of irrigate, hold, notify, step.". LEAVE. END.
                jX = jA:GetJsonObject(i).
                IF NOT jX:Has("kind") OR jX:GetType("kind") <> JsonDataType:STRING OR NOT fDrIn(jX:GetCharacter("kind"), "irrigate,hold,notify,step") THEN DO:
                    ASSIGN cBad = SUBSTITUTE("actions[&1].kind", i - 1) cMsg = "kind must be one of irrigate, hold, notify, step.". LEAVE. END.
                IF NOT fDrStr(jX, "text", 1, 300) THEN DO: ASSIGN cBad = SUBSTITUTE("actions[&1].text", i - 1) cMsg = "text is required (at most 300 characters).". LEAVE. END.
                IF NOT fGdIds(jX, "citations", 3) THEN DO: ASSIGN cBad = SUBSTITUTE("actions[&1].citations", i - 1) cMsg = "Each action needs 1 to 3 passage ids.". LEAVE. END.
                IF jX:GetCharacter("kind") = "step" AND (NOT jX:Has("cost") OR jX:GetType("cost") <> JsonDataType:STRING OR NOT fDrIn(jX:GetCharacter("cost"), cCosts)) THEN DO:
                    ASSIGN cBad = SUBSTITUTE("actions[&1].cost", i - 1) cMsg = "cost must be free, low, medium or high.". LEAVE. END.
                IF jX:GetCharacter("kind") <> "step" AND NOT fGdIsInt(jX, "suggestionId") THEN DO:
                    ASSIGN cBad = SUBSTITUTE("actions[&1].suggestionId", i - 1) cMsg = "Irrigation actions must name the suggestion OpenEdge already checked.". LEAVE. END.
            END.
        END.
    END.
    IF cBad = "" THEN DO:
        IF NOT fGdIsInt(goBody, "followUpDays") OR goBody:GetDecimal("followUpDays") < 1 OR goBody:GetDecimal("followUpDays") > 14 THEN ASSIGN cBad = "followUpDays" cMsg = "followUpDays must be 1 to 14.".
        ELSE IF NOT fDrStr(goBody, "followUpQuestion", 1, 200) THEN ASSIGN cBad = "followUpQuestion" cMsg = "followUpQuestion is required (at most 200 characters).".
        ELSE IF goBody:Has("diagnosisId") AND goBody:GetType("diagnosisId") <> JsonDataType:NULL AND NOT fGdIsInt(goBody, "diagnosisId") THEN ASSIGN cBad = "diagnosisId" cMsg = "diagnosisId must be an integer.".
    END.
    IF cBad <> "" THEN DO: RUN reply-error (400, "VALIDATION_ERROR", cMsg, cBad). RETURN. END.

    iPlot = INTEGER(goBody:GetDecimal("plotId")).
    IF NOT CAN-FIND(Plot WHERE Plot.PlotId = iPlot) THEN DO: RUN reply-error (404, "PLOT_NOT_FOUND", SUBSTITUTE("No plot with id &1.", iPlot), "plotId"). RETURN. END.
    IF fGdIsInt(goBody, "diagnosisId") THEN DO:
        iDiag = INTEGER(goBody:GetDecimal("diagnosisId")).
        IF NOT CAN-FIND(Diagnosis WHERE Diagnosis.DiagnosisId = iDiag) THEN DO: RUN reply-error (404, "DIAGNOSIS_NOT_FOUND", SUBSTITUTE("No diagnosis with id &1.", iDiag), "diagnosisId"). RETURN. END.
    END.
    DO i = 1 TO jA:Length:
        jX = jA:GetJsonObject(i).
        IF jX:GetCharacter("kind") = "step" THEN NEXT.
        iSg = INTEGER(jX:GetDecimal("suggestionId")).
        FIND bS WHERE bS.SuggestionId = iSg NO-LOCK NO-ERROR.
        IF NOT AVAILABLE bS THEN DO: RUN reply-error (404, "SUGGESTION_NOT_FOUND", SUBSTITUTE("No suggestion with id &1.", iSg), SUBSTITUTE("actions[&1].suggestionId", i - 1)). RETURN. END.
        IF bS.PlotId <> iPlot OR NOT COMPARE(bS.Action, "EQ", jX:GetCharacter("kind"), "CASE-SENSITIVE") THEN DO:
            RUN reply-error (422, "SUGGESTION_MISMATCH", SUBSTITUTE("Suggestion &1 is not a &2 for plot &3.", iSg, jX:GetCharacter("kind"), iPlot), SUBSTITUTE("actions[&1].suggestionId", i - 1)). RETURN. END.
    END.
    RUN get-str (goBody, "requestId", OUTPUT cReq, OUTPUT lOk). IF NOT lOk THEN cReq = "".

    /* RULE CITATION_UNKNOWN */
    cAllIds = fGdIdList(goBody:GetJsonArray("causeCitations")).
    DO i = 1 TO jA:Length: cAllIds = cAllIds + "," + fGdIdList(jA:GetJsonObject(i):GetJsonArray("citations")). END.
    RUN gd-unknown (cAllIds).
    IF CAN-FIND(FIRST ttGdId) THEN DO:
        jS = NEW JsonObject(). jS:Add("plotId", iPlot). jS:Add("unknown", fGdUnknownJson()).
        RUN audit (cReq, "abl-rules", "assistant_citation_blocked", fDrWrite(jS), NOW, OUTPUT iAud).
        jo = NEW JsonObject().
        jo:Add("error", "CITATION_UNKNOWN").
        jo:Add("message", "The answer cites guide passages that do not exist.").
        jo:Add("unknown", fGdUnknownJson()).
        RUN reply (422, jo). RETURN.
    END.
    /* RULE DOSE_BLOCKED over every text */
    EMPTY TEMP-TABLE ttDrBlk. giDrSeq = 0.
    RUN dr-check-text ("title", goBody:GetCharacter("title")).
    RUN dr-check-text ("likelyCause", goBody:GetCharacter("likelyCause")).
    DO i = 1 TO jE:Length: RUN dr-check-text (SUBSTITUTE("evidence[&1].text", i - 1), jE:GetJsonObject(i):GetCharacter("text")). END.
    DO i = 1 TO jA:Length: RUN dr-check-text (SUBSTITUTE("actions[&1].text", i - 1), jA:GetJsonObject(i):GetCharacter("text")). END.
    RUN dr-check-text ("followUpQuestion", goBody:GetCharacter("followUpQuestion")).
    IF CAN-FIND(FIRST ttDrBlk) THEN DO:
        jS = NEW JsonObject(). jS:Add("plotId", iPlot).
        RUN audit (cReq, "abl-rules", "assistant_dose_blocked", fDrWrite(jS), NOW, OUTPUT iAud).
        jo = NEW JsonObject().
        jo:Add("error", "DOSE_BLOCKED").
        jo:Add("message", "The answer gives a chemical dose. Doses are never shown; ask an extension officer.").
        jo:Add("blocked", fDrBlockedJson()).
        RUN reply (422, jo). RETURN.
    END.

    jEv = NEW JsonArray().
    DO i = 1 TO jE:Length:
        jS = NEW JsonObject(). jS:Add("kind", jE:GetJsonObject(i):GetCharacter("kind")). jS:Add("text", jE:GetJsonObject(i):GetCharacter("text")). jEv:Add(jS).
    END.
    jStore = NEW JsonArray().
    DO i = 1 TO jA:Length:
        jX = jA:GetJsonObject(i).
        cKind = jX:GetCharacter("kind").
        jS = NEW JsonObject().
        jS:Add("actionNo", i).
        jS:Add("kind", cKind).
        jS:Add("text", jX:GetCharacter("text")).
        jS:Add("cost", (IF cKind = "step" THEN jX:GetCharacter("cost") ELSE "")).
        jS:Add("citations", CAST(jX:GetJsonArray("citations"):Clone(), JsonArray)).
        jS:Add("suggestionId", (IF cKind = "step" THEN 0 ELSE INTEGER(jX:GetDecimal("suggestionId")))).
        jS:Add("status", "proposed").
        jS:AddNull("decidedAt").
        jStore:Add(jS).
    END.
    RUN get-str (goBody, "provider", OUTPUT cProv, OUTPUT lOk). IF NOT lOk THEN cProv = "unknown".
    iDays = INTEGER(goBody:GetDecimal("followUpDays")).
    tNow = NOW.
    DO TRANSACTION:
        CREATE AssistantCase.
        ASSIGN AssistantCase.CaseId = NEXT-VALUE(CaseSeq)
               AssistantCase.CreatedAt = tNow
               AssistantCase.PlotId = iPlot
               AssistantCase.ProblemType = goBody:GetCharacter("problemType")
               AssistantCase.CaseTitle = TRIM(goBody:GetCharacter("title"))
               AssistantCase.LikelyCause = goBody:GetCharacter("likelyCause")
               AssistantCase.Confidence = goBody:GetCharacter("confidence")
               AssistantCase.CauseCitations = fGdIdList(goBody:GetJsonArray("causeCitations"))
               AssistantCase.EvidenceJson = fDrWrite(jEv)
               AssistantCase.ActionsJson = fDrWrite(jStore)
               AssistantCase.FollowUpQuestion = goBody:GetCharacter("followUpQuestion")
               AssistantCase.DiagnosisId = iDiag
               AssistantCase.UsedFallback = (goBody:Has("usedFallback") AND goBody:GetType("usedFallback") = JsonDataType:BOOLEAN AND goBody:GetLogical("usedFallback"))
               AssistantCase.Provider = SUBSTRING(cProv, 1, 40)
               AssistantCase.CaseStatus = "open"
               AssistantCase.RequestId = cReq.
        iNew = AssistantCase.CaseId.
        CREATE CaseFollowUp.
        ASSIGN CaseFollowUp.FollowUpId = NEXT-VALUE(FollowUpSeq) CaseFollowUp.CaseId = iNew
               CaseFollowUp.DueAt = ADD-INTERVAL(tNow, iDays, "days") CaseFollowUp.Question = goBody:GetCharacter("followUpQuestion")
               CaseFollowUp.FuStatus = "due".
        RELEASE CaseFollowUp.
        RELEASE AssistantCase.
    END.
    RUN audit (cReq, "abl-rules", "assistant_case_opened",
               SUBSTITUTE('~{"caseId":&1,"plotId":&2,"problemType":"&3","actions":&4}', iNew, iPlot, goBody:GetCharacter("problemType"), jA:Length), tNow, OUTPUT iAud).
    RUN reply (201, fAsCaseJson(iNew)).
END PROCEDURE.

/* POST /farm/assistant/cases/{id}/actions/{n}/decision {decision: accept|decline, actor?} */
PROCEDURE h-as-action:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    DEFINE INPUT PARAMETER piNo AS INTEGER NO-UNDO.
    DEFINE VARIABLE oP AS ObjectModelParser NO-UNDO.
    DEFINE VARIABLE jA AS JsonArray NO-UNDO.
    DEFINE VARIABLE jX AS JsonObject NO-UNDO.
    DEFINE VARIABLE cDec AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cAct AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cReq AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cNew AS CHARACTER NO-UNDO.
    DEFINE VARIABLE lOk AS LOGICAL NO-UNDO.
    DEFINE VARIABLE iAud AS INTEGER NO-UNDO.
    DEFINE VARIABLE tNow AS DATETIME-TZ NO-UNDO.
    DEFINE BUFFER bC FOR AssistantCase.
    FIND bC WHERE bC.CaseId = piId NO-LOCK NO-ERROR.
    IF piId = ? OR NOT AVAILABLE bC THEN DO: RUN reply-error (404, "CASE_NOT_FOUND", SUBSTITUTE("No case with id &1.", (IF piId = ? THEN "?" ELSE STRING(piId))), ?). RETURN. END.
    oP = NEW ObjectModelParser().
    jA = CAST(oP:Parse(bC.ActionsJson), JsonArray).
    IF piNo = ? OR piNo < 1 OR piNo > jA:Length THEN DO:
        RUN reply-error (404, "ACTION_NOT_FOUND", SUBSTITUTE("Case &1 has no action &2.", piId, (IF piNo = ? THEN "?" ELSE STRING(piNo))), ?). RETURN. END.
    RUN get-str (goBody, "decision", OUTPUT cDec, OUTPUT lOk).
    IF NOT lOk OR NOT fDrIn(cDec, "accept,decline") THEN DO: RUN reply-error (400, "VALIDATION_ERROR", "decision must be accept or decline.", "decision"). RETURN. END.
    IF bC.CaseStatus <> "open" THEN DO: RUN reply-error (409, "CASE_CLOSED", SUBSTITUTE("Case &1 is &2.", piId, bC.CaseStatus), ?). RETURN. END.
    jX = jA:GetJsonObject(piNo).
    IF jX:GetCharacter("kind") <> "step" THEN DO:
        RUN reply-error (409, "USE_SUGGESTION_APPROVAL", SUBSTITUTE("Approve suggestion &1 with its two-step confirmation.", jX:GetInteger("suggestionId")), ?). RETURN. END.
    IF jX:GetCharacter("status") <> "proposed" THEN DO:
        RUN reply-error (409, "ALREADY_DECIDED", SUBSTITUTE("Action &1 is already &2.", piNo, jX:GetCharacter("status")), ?). RETURN. END.
    RUN get-str (goBody, "requestId", OUTPUT cReq, OUTPUT lOk). IF NOT lOk THEN cReq = "".
    RUN get-str (goBody, "actor", OUTPUT cAct, OUTPUT lOk). IF NOT lOk OR TRIM(cAct) = "" THEN cAct = "farmer".
    cNew = (IF cDec = "accept" THEN "accepted" ELSE "declined").
    tNow = NOW.
    jX:Set("status", cNew).
    jX:Set("decidedAt", fIso(tNow)).
    DO TRANSACTION:
        FIND bC WHERE bC.CaseId = piId EXCLUSIVE-LOCK.
        bC.ActionsJson = fDrWrite(jA).
        RELEASE bC.
    END.
    RUN audit (cReq, SUBSTRING(cAct, 1, 40), "assistant_action_" + cNew, SUBSTITUTE('~{"caseId":&1,"actionNo":&2}', piId, piNo), tNow, OUTPUT iAud).
    RUN reply (200, fAsCaseJson(piId)).
END PROCEDURE.

/* POST /farm/assistant/cases/{id}/follow-ups/{fid}/answer {answer, resolved, nextInDays?, actor?} */
PROCEDURE h-as-answer:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    DEFINE INPUT PARAMETER piFu AS INTEGER NO-UNDO.
    DEFINE VARIABLE cAct AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cReq AS CHARACTER NO-UNDO.
    DEFINE VARIABLE lOk AS LOGICAL NO-UNDO.
    DEFINE VARIABLE lRes AS LOGICAL NO-UNDO.
    DEFINE VARIABLE iNext AS INTEGER NO-UNDO INITIAL 3.
    DEFINE VARIABLE iAud AS INTEGER NO-UNDO.
    DEFINE VARIABLE tNow AS DATETIME-TZ NO-UNDO.
    DEFINE BUFFER bC FOR AssistantCase.
    DEFINE BUFFER bF FOR CaseFollowUp.
    FIND bC WHERE bC.CaseId = piId NO-LOCK NO-ERROR.
    IF piId = ? OR NOT AVAILABLE bC THEN DO: RUN reply-error (404, "CASE_NOT_FOUND", SUBSTITUTE("No case with id &1.", (IF piId = ? THEN "?" ELSE STRING(piId))), ?). RETURN. END.
    FIND bF WHERE bF.FollowUpId = piFu AND bF.CaseId = piId NO-LOCK NO-ERROR.
    IF piFu = ? OR NOT AVAILABLE bF THEN DO:
        RUN reply-error (404, "FOLLOWUP_NOT_FOUND", SUBSTITUTE("Case &1 has no follow-up &2.", piId, (IF piFu = ? THEN "?" ELSE STRING(piFu))), ?). RETURN. END.
    IF NOT fDrStr(goBody, "answer", 1, 500) THEN DO: RUN reply-error (400, "VALIDATION_ERROR", "answer is required (at most 500 characters).", "answer"). RETURN. END.
    IF NOT goBody:Has("resolved") OR goBody:GetType("resolved") <> JsonDataType:BOOLEAN THEN DO: RUN reply-error (400, "VALIDATION_ERROR", "resolved must be true or false.", "resolved"). RETURN. END.
    lRes = goBody:GetLogical("resolved").
    IF goBody:Has("nextInDays") THEN DO:
        IF NOT fGdIsInt(goBody, "nextInDays") OR goBody:GetDecimal("nextInDays") < 1 OR goBody:GetDecimal("nextInDays") > 14 THEN DO:
            RUN reply-error (400, "VALIDATION_ERROR", "nextInDays must be 1 to 14.", "nextInDays"). RETURN. END.
        iNext = INTEGER(goBody:GetDecimal("nextInDays")).
    END.
    IF bC.CaseStatus <> "open" THEN DO: RUN reply-error (409, "CASE_CLOSED", SUBSTITUTE("Case &1 is &2.", piId, bC.CaseStatus), ?). RETURN. END.
    IF bF.FuStatus <> "due" THEN DO: RUN reply-error (409, "ALREADY_ANSWERED", SUBSTITUTE("Follow-up &1 is already answered.", piFu), ?). RETURN. END.
    RUN get-str (goBody, "requestId", OUTPUT cReq, OUTPUT lOk). IF NOT lOk THEN cReq = "".
    RUN get-str (goBody, "actor", OUTPUT cAct, OUTPUT lOk). IF NOT lOk OR TRIM(cAct) = "" THEN cAct = "farmer".
    tNow = NOW.
    DO TRANSACTION:
        FIND bF WHERE bF.FollowUpId = piFu EXCLUSIVE-LOCK.
        ASSIGN bF.FuStatus = "answered" bF.Answer = TRIM(goBody:GetCharacter("answer")) bF.AnsweredAt = tNow.
        RELEASE bF.
        FIND bC WHERE bC.CaseId = piId EXCLUSIVE-LOCK.
        IF lRes THEN ASSIGN bC.CaseStatus = "resolved" bC.ClosedAt = tNow.
        ELSE DO:
            CREATE CaseFollowUp.
            ASSIGN CaseFollowUp.FollowUpId = NEXT-VALUE(FollowUpSeq) CaseFollowUp.CaseId = piId
                   CaseFollowUp.DueAt = ADD-INTERVAL(tNow, iNext, "days") CaseFollowUp.Question = bC.FollowUpQuestion CaseFollowUp.FuStatus = "due".
            RELEASE CaseFollowUp.
        END.
        RELEASE bC.
    END.
    RUN audit (cReq, SUBSTRING(cAct, 1, 40), (IF lRes THEN "assistant_case_resolved" ELSE "assistant_followup_answered"),
               SUBSTITUTE('~{"caseId":&1,"followUpId":&2}', piId, piFu), tNow, OUTPUT iAud).
    RUN reply (200, fAsCaseJson(piId)).
END PROCEDURE.
