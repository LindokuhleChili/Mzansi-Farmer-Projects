/*------------------------------------------------------------------------
  doctor.i - plant doctor (feature 1) and the no-doses guardrail (feature 2),
  compiled as part of farm-api.p (included after weather.i). Same behaviour as
  mock-pasoe/doctor.js (docs/DOCTOR.md). OpenEdge never sees the photos: it
  checks and stores the answer the API got from the AI (or the safe fallback).
  RULE DOSE_BLOCKED: a sentence that holds an active "dose" term AND an active
  "chemical" term from BlockedTerm is refused (422). Terms match whole words
  after normalising (lower case, a-z 0-9 %, digits split from letters).
------------------------------------------------------------------------*/

DEFINE TEMP-TABLE ttDrBlk NO-UNDO
    FIELD seqNo     AS INTEGER
    FIELD fieldName AS CHARACTER
    FIELD sentence  AS CHARACTER
    FIELD doseTerm  AS CHARACTER
    FIELD chemTerm  AS CHARACTER
    INDEX idxSeq IS PRIMARY seqNo.
DEFINE VARIABLE giDrSeq AS INTEGER NO-UNDO.

FUNCTION fDrNorm RETURNS CHARACTER (INPUT pc AS CHARACTER):
    DEFINE VARIABLE cOut AS CHARACTER NO-UNDO INITIAL " ".
    DEFINE VARIABLE cPrev AS CHARACTER NO-UNDO INITIAL " ".
    DEFINE VARIABLE cCh AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cCl AS CHARACTER NO-UNDO.
    DEFINE VARIABLE iA AS INTEGER NO-UNDO.
    DEFINE VARIABLE i AS INTEGER NO-UNDO.
    pc = LC(pc).
    DO i = 1 TO LENGTH(pc):
        cCh = SUBSTRING(pc, i, 1).
        iA = ASC(cCh).
        cCl = (IF iA >= 97 AND iA <= 122 THEN "a" ELSE IF iA >= 48 AND iA <= 57 THEN "9" ELSE IF iA = 37 THEN "%" ELSE " ").
        IF cCl = " " THEN DO:
            IF cPrev <> " " THEN cOut = cOut + " ".
            cPrev = " ".
            NEXT.
        END.
        IF cPrev <> " " AND cPrev <> cCl THEN cOut = cOut + " ".
        ASSIGN cOut = cOut + cCh cPrev = cCl.
    END.
    IF SUBSTRING(cOut, LENGTH(cOut), 1) <> " " THEN cOut = cOut + " ".
    RETURN cOut.
END FUNCTION.

/* adds one ttDrBlk row per blocked sentence of pcText */
PROCEDURE dr-check-text:
    DEFINE INPUT PARAMETER pcField AS CHARACTER NO-UNDO.
    DEFINE INPUT PARAMETER pcText  AS CHARACTER NO-UNDO.
    DEFINE BUFFER bT FOR BlockedTerm.
    DEFINE VARIABLE cTxt AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cSen AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cNorm AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cDose AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cChem AS CHARACTER NO-UNDO.
    DEFINE VARIABLE i AS INTEGER NO-UNDO.
    cTxt = pcText.
    cTxt = REPLACE(cTxt, ".", CHR(1)). cTxt = REPLACE(cTxt, "!", CHR(1)). cTxt = REPLACE(cTxt, "?", CHR(1)).
    cTxt = REPLACE(cTxt, ";", CHR(1)). cTxt = REPLACE(cTxt, CHR(10), CHR(1)).
    DO i = 1 TO NUM-ENTRIES(cTxt, CHR(1)):
        cSen = TRIM(ENTRY(i, cTxt, CHR(1))).
        IF cSen = "" THEN NEXT.
        ASSIGN cNorm = fDrNorm(cSen) cDose = "" cChem = "".
        FOR EACH bT NO-LOCK WHERE bT.TermKind = "dose" AND bT.Active BY bT.TermId:
            IF INDEX(cNorm, fDrNorm(bT.TermText)) > 0 THEN DO: cDose = bT.TermText. LEAVE. END.
        END.
        IF cDose = "" THEN NEXT.
        FOR EACH bT NO-LOCK WHERE bT.TermKind = "chemical" AND bT.Active BY bT.TermId:
            IF INDEX(cNorm, fDrNorm(bT.TermText)) > 0 THEN DO: cChem = bT.TermText. LEAVE. END.
        END.
        IF cChem = "" THEN NEXT.
        giDrSeq = giDrSeq + 1.
        CREATE ttDrBlk.
        ASSIGN ttDrBlk.seqNo = giDrSeq ttDrBlk.fieldName = pcField ttDrBlk.sentence = SUBSTRING(cSen, 1, 300)
               ttDrBlk.doseTerm = cDose ttDrBlk.chemTerm = cChem.
    END.
END PROCEDURE.

FUNCTION fDrBlockedJson RETURNS JsonArray ():
    DEFINE VARIABLE ja AS JsonArray NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    ja = NEW JsonArray().
    FOR EACH ttDrBlk BY ttDrBlk.seqNo:
        jo = NEW JsonObject().
        jo:Add("code", "DOSE_BLOCKED").
        jo:Add("field", ttDrBlk.fieldName).
        jo:Add("sentence", ttDrBlk.sentence).
        jo:Add("doseTerm", ttDrBlk.doseTerm).
        jo:Add("chemicalTerm", ttDrBlk.chemTerm).
        ja:Add(jo).
    END.
    RETURN ja.
END FUNCTION.

FUNCTION fDrWrite RETURNS CHARACTER (INPUT po AS Progress.Json.ObjectModel.JsonConstruct):
    DEFINE VARIABLE lc AS LONGCHAR NO-UNDO.
    po:Write(INPUT-OUTPUT lc, FALSE).
    RETURN STRING(lc).
END FUNCTION.

/* case-sensitive membership (LOOKUP and CAN-DO ignore case; the JSON contract does not) */
FUNCTION fDrIn RETURNS LOGICAL (INPUT pc AS CHARACTER, INPUT pcList AS CHARACTER):
    DEFINE VARIABLE i AS INTEGER NO-UNDO.
    IF pc = ? THEN RETURN FALSE.
    DO i = 1 TO NUM-ENTRIES(pcList):
        IF COMPARE(ENTRY(i, pcList), "EQ", pc, "CASE-SENSITIVE") THEN RETURN TRUE.
    END.
    RETURN FALSE.
END FUNCTION.

FUNCTION fDrStr RETURNS LOGICAL (INPUT poJo AS JsonObject, INPUT pcName AS CHARACTER, INPUT piMin AS INTEGER, INPUT piMax AS INTEGER):
    DEFINE VARIABLE c AS CHARACTER NO-UNDO.
    IF NOT poJo:Has(pcName) OR poJo:GetType(pcName) <> JsonDataType:STRING THEN RETURN FALSE.
    c = poJo:GetCharacter(pcName).
    RETURN LENGTH(TRIM(c)) >= piMin AND LENGTH(c) <= piMax.
END FUNCTION.

FUNCTION fDrTermJson RETURNS JsonObject (INPUT piId AS INTEGER):
    DEFINE BUFFER bT FOR BlockedTerm.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    FIND bT WHERE bT.TermId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bT THEN RETURN ?.
    jo = NEW JsonObject().
    jo:Add("termId", bT.TermId).
    jo:Add("term", bT.TermText).
    jo:Add("kind", bT.TermKind).
    jo:Add("active", bT.Active).
    IF bT.UpdatedAt = ? THEN jo:AddNull("updatedAt"). ELSE jo:Add("updatedAt", fIso(bT.UpdatedAt)).
    jo:Add("updatedBy", bT.UpdatedBy).
    RETURN jo.
END FUNCTION.

FUNCTION fDrDiagJson RETURNS JsonObject (INPUT piId AS INTEGER):
    DEFINE BUFFER bD FOR Diagnosis.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE VARIABLE jr AS JsonObject NO-UNDO.
    DEFINE VARIABLE oP AS ObjectModelParser NO-UNDO.
    FIND bD WHERE bD.DiagnosisId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bD THEN RETURN ?.
    oP = NEW ObjectModelParser().
    jo = NEW JsonObject().
    jo:Add("diagnosisId", bD.DiagnosisId).
    jo:Add("createdAt", fIso(bD.CreatedAt)).
    jo:Add("crop", bD.Crop).
    jo:Add("plantPart", bD.PlantPart).
    jo:Add("growthStage", bD.GrowthStage).
    jo:Add("province", bD.Province).
    jo:Add("photoCount", bD.PhotoCount).
    jo:Add("condition", bD.ConditionName).
    jo:Add("confidence", bD.Confidence).
    jo:Add("observations", bD.Observations).
    jo:Add("steps", CAST(oP:Parse(bD.StepsJson), JsonArray)).
    jo:Add("monitor", CAST(oP:Parse(bD.MonitorJson), JsonArray)).
    jr = NEW JsonObject().
    jr:Add("level", bD.RiskLevel).
    jr:Add("reason", bD.RiskReason).
    jo:Add("neighbourRisk", jr).
    jo:Add("callExpert", bD.CallExpert).
    jo:Add("usedFallback", bD.UsedFallback).
    jo:Add("fallbackReason", bD.FallbackReason).
    jo:Add("verdict", "passed").
    jo:Add("status", bD.DiagStatus).
    IF bD.DecidedAt = ? THEN jo:AddNull("decidedAt"). ELSE jo:Add("decidedAt", fIso(bD.DecidedAt)).
    RETURN jo.
END FUNCTION.

/* GET /farm/doctor/blocked-terms */
PROCEDURE h-dr-terms:
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE VARIABLE ja AS JsonArray NO-UNDO.
    DEFINE BUFFER bT FOR BlockedTerm.
    ja = NEW JsonArray().
    FOR EACH bT NO-LOCK BY bT.TermId: ja:Add(fDrTermJson(bT.TermId)). END.
    jo = NEW JsonObject().
    jo:Add("terms", ja).
    RUN reply (200, jo).
END PROCEDURE.

/* GET /farm/doctor/diagnoses?limit= */
PROCEDURE h-dr-list:
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE VARIABLE ja AS JsonArray NO-UNDO.
    DEFINE VARIABLE iLim AS INTEGER NO-UNDO.
    DEFINE VARIABLE iN AS INTEGER NO-UNDO.
    DEFINE BUFFER bD FOR Diagnosis.
    iLim = INTEGER(fQuery("limit")) NO-ERROR.
    IF ERROR-STATUS:ERROR OR iLim = ? OR iLim < 1 THEN iLim = 20.
    IF iLim > 100 THEN iLim = 100.
    ja = NEW JsonArray().
    FOR EACH bD NO-LOCK BY bD.DiagnosisId DESCENDING:
        iN = iN + 1.
        IF iN > iLim THEN LEAVE.
        ja:Add(fDrDiagJson(bD.DiagnosisId)).
    END.
    jo = NEW JsonObject().
    jo:Add("diagnoses", ja).
    RUN reply (200, jo).
END PROCEDURE.

PROCEDURE h-dr-get:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    IF piId = ? OR NOT CAN-FIND(Diagnosis WHERE Diagnosis.DiagnosisId = piId) THEN DO:
        RUN reply-error (404, "DIAGNOSIS_NOT_FOUND", SUBSTITUTE("No diagnosis with id &1.", (IF piId = ? THEN "?" ELSE STRING(piId))), ?). RETURN.
    END.
    RUN reply (200, fDrDiagJson(piId)).
END PROCEDURE.

/* POST /farm/doctor/check {texts:[...]} - the rule alone, writes nothing */
PROCEDURE h-dr-check:
    DEFINE VARIABLE ja AS JsonArray NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE VARIABLE i AS INTEGER NO-UNDO.
    IF NOT goBody:Has("texts") OR goBody:GetType("texts") <> JsonDataType:ARRAY THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "texts must be 1 to 20 strings of at most 2000 characters.", "texts"). RETURN.
    END.
    ja = goBody:GetJsonArray("texts").
    IF ja:Length < 1 OR ja:Length > 20 THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "texts must be 1 to 20 strings of at most 2000 characters.", "texts"). RETURN.
    END.
    DO i = 1 TO ja:Length:
        IF ja:GetType(i) <> JsonDataType:STRING OR LENGTH(ja:GetCharacter(i)) > 2000 THEN DO:
            RUN reply-error (400, "VALIDATION_ERROR", "texts must be 1 to 20 strings of at most 2000 characters.", "texts"). RETURN.
        END.
    END.
    EMPTY TEMP-TABLE ttDrBlk. giDrSeq = 0.
    DO i = 1 TO ja:Length:
        RUN dr-check-text (SUBSTITUTE("texts[&1]", i - 1), ja:GetCharacter(i)).
    END.
    jo = NEW JsonObject().
    jo:Add("verdict", (IF CAN-FIND(FIRST ttDrBlk) THEN "blocked" ELSE "passed")).
    jo:Add("blocked", fDrBlockedJson()).
    RUN reply (200, jo).
END PROCEDURE.

/* POST /farm/doctor/diagnoses {crop, plantPart, growthStage, province, photoCount, result, usedFallback?, fallbackReason?, requestId?} */
PROCEDURE h-dr-create:
    DEFINE VARIABLE jr AS JsonObject NO-UNDO.
    DEFINE VARIABLE jS AS JsonArray NO-UNDO.
    DEFINE VARIABLE jM AS JsonArray NO-UNDO.
    DEFINE VARIABLE jSo AS JsonObject NO-UNDO.
    DEFINE VARIABLE jNr AS JsonObject NO-UNDO.
    DEFINE VARIABLE jSteps AS JsonArray NO-UNDO.
    DEFINE VARIABLE jMon AS JsonArray NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE VARIABLE jBad AS JsonObject NO-UNDO.
    DEFINE VARIABLE jDet AS JsonObject NO-UNDO.
    DEFINE VARIABLE jDa AS JsonArray NO-UNDO.
    DEFINE VARIABLE cBad AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cReq AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cFbr AS CHARACTER NO-UNDO.
    DEFINE VARIABLE lFb AS LOGICAL NO-UNDO.
    DEFINE VARIABLE lOk AS LOGICAL NO-UNDO.
    DEFINE VARIABLE dPc AS DECIMAL NO-UNDO.
    DEFINE VARIABLE i AS INTEGER NO-UNDO.
    DEFINE VARIABLE iId AS INTEGER NO-UNDO.
    DEFINE VARIABLE iAud AS INTEGER NO-UNDO.
    DEFINE VARIABLE tNow AS DATETIME-TZ NO-UNDO.
    DEFINE VARIABLE cCosts AS CHARACTER NO-UNDO INITIAL "free,low,medium,high".
    DEFINE VARIABLE cProv AS CHARACTER NO-UNDO INITIAL "Eastern Cape,Free State,Gauteng,KwaZulu-Natal,Limpopo,Mpumalanga,North West,Northern Cape,Western Cape".

    IF NOT fDrStr(goBody, "crop", 1, 40) THEN DO: RUN reply-error (400, "VALIDATION_ERROR", "crop is required (at most 40 characters).", "crop"). RETURN. END.
    IF NOT fDrStr(goBody, "plantPart", 1, 20) OR NOT fDrIn(goBody:GetCharacter("plantPart"), "leaf,stem,fruit,root,flower,whole_plant") THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "plantPart must be one of leaf, stem, fruit, root, flower, whole_plant.", "plantPart"). RETURN. END.
    IF NOT fDrStr(goBody, "growthStage", 1, 20) OR NOT fDrIn(goBody:GetCharacter("growthStage"), "seedling,vegetative,flowering,fruiting,mature") THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "growthStage must be one of seedling, vegetative, flowering, fruiting, mature.", "growthStage"). RETURN. END.
    IF NOT fDrStr(goBody, "province", 1, 20) OR NOT fDrIn(goBody:GetCharacter("province"), cProv) THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "province must be one of the 9 South African provinces.", "province"). RETURN. END.
    RUN get-num (goBody, "photoCount", OUTPUT dPc, OUTPUT lOk).
    IF NOT lOk OR dPc <> TRUNCATE(dPc, 0) OR dPc < 1 OR dPc > 3 THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "photoCount must be 1, 2 or 3.", "photoCount"). RETURN. END.

    /* shape of the answer: same order of checks as resultProblem() in mock-pasoe/doctor.js */
    IF NOT goBody:Has("result") OR goBody:GetType("result") <> JsonDataType:OBJECT THEN cBad = "result".
    ELSE DO:
        jr = goBody:GetJsonObject("result").
        IF NOT fDrStr(jr, "condition", 1, 120) THEN cBad = "result.condition".
        ELSE IF NOT jr:Has("confidence") OR jr:GetType("confidence") <> JsonDataType:STRING OR NOT fDrIn(jr:GetCharacter("confidence"), "low,medium,high") THEN cBad = "result.confidence".
        ELSE IF NOT jr:Has("observations") OR jr:GetType("observations") <> JsonDataType:STRING OR LENGTH(jr:GetCharacter("observations")) > 1000 THEN cBad = "result.observations".
        ELSE IF NOT jr:Has("steps") OR jr:GetType("steps") <> JsonDataType:ARRAY THEN cBad = "result.steps".
        ELSE DO:
            jS = jr:GetJsonArray("steps").
            IF jS:Length < 3 OR jS:Length > 5 THEN cBad = "result.steps".
            ELSE DO i = 1 TO jS:Length:
                IF jS:GetType(i) <> JsonDataType:OBJECT THEN DO: cBad = SUBSTITUTE("result.steps[&1].text", i - 1). LEAVE. END.
                jSo = jS:GetJsonObject(i).
                IF NOT fDrStr(jSo, "text", 1, 300) THEN DO: cBad = SUBSTITUTE("result.steps[&1].text", i - 1). LEAVE. END.
                IF NOT jSo:Has("cost") OR jSo:GetType("cost") <> JsonDataType:STRING OR NOT fDrIn(jSo:GetCharacter("cost"), cCosts) THEN DO:
                    cBad = SUBSTITUTE("result.steps[&1].cost", i - 1). LEAVE. END.
            END.
        END.
        IF cBad = "" THEN DO:
            IF NOT jr:Has("monitor") OR jr:GetType("monitor") <> JsonDataType:ARRAY THEN cBad = "result.monitor".
            ELSE DO:
                jM = jr:GetJsonArray("monitor").
                IF jM:Length < 1 OR jM:Length > 5 THEN cBad = "result.monitor".
                ELSE DO i = 1 TO jM:Length:
                    IF jM:GetType(i) <> JsonDataType:STRING OR LENGTH(TRIM(jM:GetCharacter(i))) < 1 OR LENGTH(jM:GetCharacter(i)) > 200 THEN DO: cBad = "result.monitor". LEAVE. END.
                END.
            END.
        END.
        IF cBad = "" THEN DO:
            IF NOT jr:Has("neighbourRisk") OR jr:GetType("neighbourRisk") <> JsonDataType:OBJECT THEN cBad = "result.neighbourRisk.level".
            ELSE DO:
                jNr = jr:GetJsonObject("neighbourRisk").
                IF NOT jNr:Has("level") OR jNr:GetType("level") <> JsonDataType:STRING OR NOT fDrIn(jNr:GetCharacter("level"), "low,medium,high") THEN cBad = "result.neighbourRisk.level".
                ELSE IF NOT fDrStr(jNr, "reason", 1, 300) THEN cBad = "result.neighbourRisk.reason".
            END.
        END.
        IF cBad = "" AND NOT fDrStr(jr, "callExpert", 1, 300) THEN cBad = "result.callExpert".
    END.
    IF cBad <> "" THEN DO: RUN reply-error (400, "VALIDATION_ERROR", cBad + " is missing or not valid.", cBad). RETURN. END.

    DO i = 2 TO jS:Length:
        IF LOOKUP(jS:GetJsonObject(i):GetCharacter("cost"), cCosts) < LOOKUP(jS:GetJsonObject(i - 1):GetCharacter("cost"), cCosts) THEN DO:
            RUN reply-error (400, "STEPS_NOT_CHEAPEST_FIRST", "Steps must be ordered cheapest first (free, low, medium, high).", "result.steps"). RETURN.
        END.
    END.

    RUN get-str (goBody, "requestId", OUTPUT cReq, OUTPUT lOk). IF NOT lOk THEN cReq = "".
    /* RULE DOSE_BLOCKED over every text of the answer */
    EMPTY TEMP-TABLE ttDrBlk. giDrSeq = 0.
    RUN dr-check-text ("condition", jr:GetCharacter("condition")).
    RUN dr-check-text ("observations", jr:GetCharacter("observations")).
    DO i = 1 TO jS:Length: RUN dr-check-text (SUBSTITUTE("steps[&1].text", i - 1), jS:GetJsonObject(i):GetCharacter("text")). END.
    DO i = 1 TO jM:Length: RUN dr-check-text (SUBSTITUTE("monitor[&1]", i - 1), jM:GetCharacter(i)). END.
    RUN dr-check-text ("neighbourRisk.reason", jNr:GetCharacter("reason")).
    RUN dr-check-text ("callExpert", jr:GetCharacter("callExpert")).
    IF CAN-FIND(FIRST ttDrBlk) THEN DO:
        jDet = NEW JsonObject().
        jDet:Add("crop", goBody:GetCharacter("crop")).
        jDa = NEW JsonArray().
        FOR EACH ttDrBlk BY ttDrBlk.seqNo:
            jBad = NEW JsonObject().
            jBad:Add("field", ttDrBlk.fieldName). jBad:Add("doseTerm", ttDrBlk.doseTerm). jBad:Add("chemicalTerm", ttDrBlk.chemTerm).
            jDa:Add(jBad).
        END.
        jDet:Add("blocked", jDa).
        RUN audit (cReq, "abl-rules", "doctor_dose_blocked", fDrWrite(jDet), NOW, OUTPUT iAud).
        jo = NEW JsonObject().
        jo:Add("error", "DOSE_BLOCKED").
        jo:Add("message", "The answer gives a chemical dose. Doses are never shown; ask an extension officer.").
        jo:Add("blocked", fDrBlockedJson()).
        RUN reply (422, jo).
        RETURN.
    END.

    lFb = goBody:Has("usedFallback") AND goBody:GetType("usedFallback") = JsonDataType:BOOLEAN AND goBody:GetLogical("usedFallback") = TRUE.
    RUN get-str (goBody, "fallbackReason", OUTPUT cFbr, OUTPUT lOk). IF NOT lOk THEN cFbr = "".
    jSteps = NEW JsonArray().
    DO i = 1 TO jS:Length:
        jSo = NEW JsonObject().
        jSo:Add("text", jS:GetJsonObject(i):GetCharacter("text")).
        jSo:Add("cost", jS:GetJsonObject(i):GetCharacter("cost")).
        jSteps:Add(jSo).
    END.
    jMon = NEW JsonArray().
    DO i = 1 TO jM:Length: jMon:Add(jM:GetCharacter(i)). END.
    tNow = NOW.
    DO TRANSACTION:
        CREATE Diagnosis.
        ASSIGN Diagnosis.DiagnosisId = NEXT-VALUE(DiagnosisSeq)
               Diagnosis.CreatedAt = tNow
               Diagnosis.Crop = TRIM(goBody:GetCharacter("crop"))
               Diagnosis.PlantPart = goBody:GetCharacter("plantPart")
               Diagnosis.GrowthStage = goBody:GetCharacter("growthStage")
               Diagnosis.Province = goBody:GetCharacter("province")
               Diagnosis.PhotoCount = INTEGER(dPc)
               Diagnosis.ConditionName = jr:GetCharacter("condition")
               Diagnosis.Confidence = jr:GetCharacter("confidence")
               Diagnosis.Observations = jr:GetCharacter("observations")
               Diagnosis.StepsJson = fDrWrite(jSteps)
               Diagnosis.MonitorJson = fDrWrite(jMon)
               Diagnosis.RiskLevel = jNr:GetCharacter("level")
               Diagnosis.RiskReason = jNr:GetCharacter("reason")
               Diagnosis.CallExpert = jr:GetCharacter("callExpert")
               Diagnosis.UsedFallback = lFb
               Diagnosis.FallbackReason = SUBSTRING(cFbr, 1, 40)
               Diagnosis.DiagStatus = "pending_review"
               Diagnosis.DecidedAt = ?
               Diagnosis.RequestId = SUBSTRING(cReq, 1, 40).
        iId = Diagnosis.DiagnosisId.
        RELEASE Diagnosis.
    END.
    jDet = NEW JsonObject().
    jDet:Add("diagnosisId", iId). jDet:Add("crop", TRIM(goBody:GetCharacter("crop"))). jDet:Add("condition", jr:GetCharacter("condition")). jDet:Add("usedFallback", lFb).
    RUN audit (cReq, "abl-rules", "doctor_diagnosis_created", fDrWrite(jDet), tNow, OUTPUT iAud).
    RUN reply (201, fDrDiagJson(iId)).
END PROCEDURE.

/* POST /farm/doctor/diagnoses/{id}/decision {decision: save|dismiss, actor?} - the farmer's sign-off */
PROCEDURE h-dr-decide:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    DEFINE VARIABLE cDec AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cActor AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cReq AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cSt AS CHARACTER NO-UNDO.
    DEFINE VARIABLE lOk AS LOGICAL NO-UNDO.
    DEFINE VARIABLE iAud AS INTEGER NO-UNDO.
    DEFINE BUFFER bD FOR Diagnosis.
    FIND bD WHERE bD.DiagnosisId = piId EXCLUSIVE-LOCK NO-ERROR.
    IF piId = ? OR NOT AVAILABLE bD THEN DO:
        RUN reply-error (404, "DIAGNOSIS_NOT_FOUND", SUBSTITUTE("No diagnosis with id &1.", (IF piId = ? THEN "?" ELSE STRING(piId))), ?). RETURN.
    END.
    RUN get-str (goBody, "decision", OUTPUT cDec, OUTPUT lOk).
    IF NOT lOk OR NOT fDrIn(cDec, "save,dismiss") THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "decision must be save or dismiss.", "decision"). RETURN.
    END.
    IF bD.DiagStatus <> "pending_review" THEN DO:
        RUN reply-error (409, "ALREADY_DECIDED", SUBSTITUTE("Diagnosis &1 is already &2.", bD.DiagnosisId, bD.DiagStatus), ?). RETURN.
    END.
    RUN get-str (goBody, "actor", OUTPUT cActor, OUTPUT lOk). IF NOT lOk THEN cActor = "farmer".
    RUN get-str (goBody, "requestId", OUTPUT cReq, OUTPUT lOk). IF NOT lOk THEN cReq = "".
    cSt = (IF cDec = "save" THEN "saved" ELSE "dismissed").
    ASSIGN bD.DiagStatus = cSt bD.DecidedAt = NOW.
    RELEASE bD.
    RUN audit (cReq, SUBSTRING(cActor, 1, 40), "doctor_diagnosis_" + cSt, SUBSTITUTE('~{"diagnosisId":&1}', piId), NOW, OUTPUT iAud).
    RUN reply (200, fDrDiagJson(piId)).
END PROCEDURE.

/* POST /farm/doctor/blocked-terms {term, kind, updatedBy?} */
PROCEDURE h-dr-term-add:
    DEFINE VARIABLE cTerm AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cKind AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cBy AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cReq AS CHARACTER NO-UNDO.
    DEFINE VARIABLE lOk AS LOGICAL NO-UNDO.
    DEFINE VARIABLE lGood AS LOGICAL NO-UNDO.
    DEFINE VARIABLE i AS INTEGER NO-UNDO.
    DEFINE VARIABLE iA AS INTEGER NO-UNDO.
    DEFINE VARIABLE iId AS INTEGER NO-UNDO.
    DEFINE VARIABLE iAud AS INTEGER NO-UNDO.
    DEFINE VARIABLE tNow AS DATETIME-TZ NO-UNDO.
    RUN get-str (goBody, "term", OUTPUT cTerm, OUTPUT lOk). IF NOT lOk THEN cTerm = "".
    cTerm = LC(TRIM(cTerm)).
    lGood = cTerm <> "" AND LENGTH(cTerm) <= 40.
    IF lGood THEN DO i = 1 TO LENGTH(cTerm):
        iA = ASC(SUBSTRING(cTerm, i, 1)).
        IF NOT ((iA >= 97 AND iA <= 122) OR (iA >= 48 AND iA <= 57) OR iA = 37 OR iA = 32) THEN DO: lGood = FALSE. LEAVE. END.
    END.
    IF NOT lGood THEN DO: RUN reply-error (400, "BLOCKED_TERM_INVALID", "term must be 1 to 40 letters, digits, spaces or %.", "term"). RETURN. END.
    RUN get-str (goBody, "kind", OUTPUT cKind, OUTPUT lOk).
    IF NOT lOk OR NOT fDrIn(cKind, "dose,chemical") THEN DO:
        RUN reply-error (400, "BLOCKED_TERM_INVALID", "kind must be dose or chemical.", "kind"). RETURN. END.
    IF CAN-FIND(FIRST BlockedTerm WHERE BlockedTerm.TermKind = cKind AND BlockedTerm.TermText = cTerm) THEN DO:
        RUN reply-error (409, "TERM_EXISTS", SUBSTITUTE('"&1" is already in the &2 list.', cTerm, cKind), "term"). RETURN. END.
    RUN get-str (goBody, "updatedBy", OUTPUT cBy, OUTPUT lOk). IF NOT lOk THEN cBy = "admin".
    RUN get-str (goBody, "requestId", OUTPUT cReq, OUTPUT lOk). IF NOT lOk THEN cReq = "".
    tNow = NOW.
    DO TRANSACTION:
        CREATE BlockedTerm.
        ASSIGN BlockedTerm.TermId = NEXT-VALUE(TermSeq) BlockedTerm.TermText = cTerm BlockedTerm.TermKind = cKind
               BlockedTerm.Active = TRUE BlockedTerm.UpdatedAt = tNow BlockedTerm.UpdatedBy = SUBSTRING(cBy, 1, 40).
        iId = BlockedTerm.TermId.
        RELEASE BlockedTerm.
    END.
    RUN audit (cReq, SUBSTRING(cBy, 1, 40), "blocked_term_added", SUBSTITUTE('~{"termId":&1,"term":"&2","kind":"&3"}', iId, cTerm, cKind), tNow, OUTPUT iAud).
    RUN reply (201, fDrTermJson(iId)).
END PROCEDURE.

/* POST /farm/doctor/blocked-terms/{id} {active, updatedBy?} */
PROCEDURE h-dr-term-save:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    DEFINE VARIABLE cBy AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cReq AS CHARACTER NO-UNDO.
    DEFINE VARIABLE lOk AS LOGICAL NO-UNDO.
    DEFINE VARIABLE lAct AS LOGICAL NO-UNDO.
    DEFINE VARIABLE iAud AS INTEGER NO-UNDO.
    DEFINE BUFFER bT FOR BlockedTerm.
    FIND bT WHERE bT.TermId = piId EXCLUSIVE-LOCK NO-ERROR.
    IF piId = ? OR NOT AVAILABLE bT THEN DO:
        RUN reply-error (404, "TERM_NOT_FOUND", SUBSTITUTE("No blocked term with id &1.", (IF piId = ? THEN "?" ELSE STRING(piId))), ?). RETURN.
    END.
    IF NOT goBody:Has("active") OR goBody:GetType("active") <> JsonDataType:BOOLEAN THEN DO:
        RUN reply-error (400, "BLOCKED_TERM_INVALID", "active must be true or false.", "active"). RETURN.
    END.
    lAct = goBody:GetLogical("active").
    RUN get-str (goBody, "updatedBy", OUTPUT cBy, OUTPUT lOk). IF NOT lOk THEN cBy = "admin".
    RUN get-str (goBody, "requestId", OUTPUT cReq, OUTPUT lOk). IF NOT lOk THEN cReq = "".
    ASSIGN bT.Active = lAct bT.UpdatedAt = NOW bT.UpdatedBy = SUBSTRING(cBy, 1, 40).
    RELEASE bT.
    RUN audit (cReq, SUBSTRING(cBy, 1, 40), "blocked_term_changed", SUBSTITUTE('~{"termId":&1,"active":&2}', piId, (IF lAct THEN "true" ELSE "false")), NOW, OUTPUT iAud).
    RUN reply (200, fDrTermJson(piId)).
END PROCEDURE.
