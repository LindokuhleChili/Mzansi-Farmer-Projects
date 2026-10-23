/* iso.i - ISO 8601 helpers shared by farm-api.p and seed.p */
FUNCTION fIso RETURNS CHARACTER (INPUT ptDt AS DATETIME-TZ):
    IF ptDt = ? THEN RETURN ?.
    RETURN REPLACE(ISO-DATE(DATETIME-TZ(ptDt, 0)), "+00:00", "Z").
END FUNCTION.

/* Parse ISO 8601 (yyyy-mm-ddThh:mm:ss[.sss](Z|+hh:mm)). Returns ? when invalid. */
FUNCTION fParseIso RETURNS DATETIME-TZ (INPUT pcIso AS CHARACTER):
    DEFINE VARIABLE iY AS INTEGER NO-UNDO. DEFINE VARIABLE iMo AS INTEGER NO-UNDO.
    DEFINE VARIABLE iD AS INTEGER NO-UNDO. DEFINE VARIABLE iH AS INTEGER NO-UNDO.
    DEFINE VARIABLE iMi AS INTEGER NO-UNDO. DEFINE VARIABLE iS AS INTEGER NO-UNDO.
    DEFINE VARIABLE iMs AS INTEGER NO-UNDO. DEFINE VARIABLE iTz AS INTEGER NO-UNDO.
    DEFINE VARIABLE cRest AS CHARACTER NO-UNDO. DEFINE VARIABLE cFrac AS CHARACTER NO-UNDO.
    DEFINE VARIABLE iPos AS INTEGER NO-UNDO. DEFINE VARIABLE iSign AS INTEGER NO-UNDO.
    DEFINE VARIABLE dtRes AS DATETIME-TZ NO-UNDO.

    pcIso = TRIM(pcIso).
    IF pcIso = ? OR LENGTH(pcIso) < 20 THEN RETURN ?.
    IF SUBSTRING(pcIso, 5, 1) <> "-" OR SUBSTRING(pcIso, 8, 1) <> "-"
       OR SUBSTRING(pcIso, 11, 1) <> "T" OR SUBSTRING(pcIso, 14, 1) <> ":"
       OR SUBSTRING(pcIso, 17, 1) <> ":" THEN RETURN ?.
    ASSIGN iY  = INTEGER(SUBSTRING(pcIso, 1, 4))  iMo = INTEGER(SUBSTRING(pcIso, 6, 2))
           iD  = INTEGER(SUBSTRING(pcIso, 9, 2))  iH  = INTEGER(SUBSTRING(pcIso, 12, 2))
           iMi = INTEGER(SUBSTRING(pcIso, 15, 2)) iS  = INTEGER(SUBSTRING(pcIso, 18, 2))
           NO-ERROR.
    IF ERROR-STATUS:ERROR THEN RETURN ?.
    IF iMo < 1 OR iMo > 12 OR iD < 1 OR iD > 31 OR iH > 23 OR iMi > 59 OR iS > 59 THEN RETURN ?.
    cRest = SUBSTRING(pcIso, 20).
    IF SUBSTRING(cRest, 1, 1) = "." THEN DO:
        iPos = 2.
        cFrac = "".
        DO WHILE iPos <= LENGTH(cRest) AND INDEX("0123456789", SUBSTRING(cRest, iPos, 1)) > 0:
            cFrac = cFrac + SUBSTRING(cRest, iPos, 1).
            iPos = iPos + 1.
        END.
        cFrac = SUBSTRING(cFrac + "000", 1, 3).
        iMs = INTEGER(cFrac).
        cRest = SUBSTRING(cRest, iPos).
    END.
    IF cRest = "Z" OR cRest = "z" THEN iTz = 0.
    ELSE IF LENGTH(cRest) = 6 AND (SUBSTRING(cRest, 1, 1) = "+" OR SUBSTRING(cRest, 1, 1) = "-")
            AND SUBSTRING(cRest, 4, 1) = ":" THEN DO:
        iSign = (IF SUBSTRING(cRest, 1, 1) = "-" THEN -1 ELSE 1).
        iTz = iSign * (INTEGER(SUBSTRING(cRest, 2, 2)) * 60 + INTEGER(SUBSTRING(cRest, 5, 2))) NO-ERROR.
        IF ERROR-STATUS:ERROR THEN RETURN ?.
    END.
    ELSE RETURN ?.
    dtRes = DATETIME-TZ(iMo, iD, iY, iH, iMi, iS, iMs, iTz) NO-ERROR.
    IF ERROR-STATUS:ERROR THEN RETURN ?.
    RETURN dtRes.
END FUNCTION.

