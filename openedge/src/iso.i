/* iso.i - ISO 8601 helpers shared by farm-api.p and seed.p */
FUNCTION fIso RETURNS CHARACTER (INPUT ptDt AS DATETIME-TZ):
    IF ptDt = ? THEN RETURN ?.
    RETURN REPLACE(ISO-DATE(DATETIME-TZ(ptDt, 0)), "+00:00", "Z").
END FUNCTION.

/* Days in a month, leap years included (divisible by 4, except centuries unless divisible by 400). */
FUNCTION fDaysInMonth RETURNS INTEGER (INPUT piYr AS INTEGER, INPUT piMon AS INTEGER):
    IF piMon = 2 THEN
        RETURN (IF (piYr MODULO 4 = 0 AND piYr MODULO 100 <> 0) OR piYr MODULO 400 = 0 THEN 29 ELSE 28).
    IF piMon = 4 OR piMon = 6 OR piMon = 9 OR piMon = 11 THEN RETURN 30.
    RETURN 31.
END FUNCTION.

/* Parse ISO 8601 (yyyy-mm-ddThh:mm:ss[.sss](Z|+hh:mm)). Returns ? when invalid. */
FUNCTION fParseIso RETURNS DATETIME-TZ (INPUT pcIso AS CHARACTER):
    DEFINE VARIABLE iYr AS INTEGER NO-UNDO. DEFINE VARIABLE iMon AS INTEGER NO-UNDO.
    DEFINE VARIABLE iDay AS INTEGER NO-UNDO. DEFINE VARIABLE iHr AS INTEGER NO-UNDO.
    DEFINE VARIABLE iMin AS INTEGER NO-UNDO. DEFINE VARIABLE iSec AS INTEGER NO-UNDO.
    DEFINE VARIABLE iMs AS INTEGER NO-UNDO. DEFINE VARIABLE iTz AS INTEGER NO-UNDO.
    DEFINE VARIABLE cRest AS CHARACTER NO-UNDO. DEFINE VARIABLE cFrac AS CHARACTER NO-UNDO.
    DEFINE VARIABLE iPos AS INTEGER NO-UNDO. DEFINE VARIABLE iSign AS INTEGER NO-UNDO.
    DEFINE VARIABLE dtRes AS DATETIME-TZ NO-UNDO.

    pcIso = TRIM(pcIso).
    IF pcIso = ? OR LENGTH(pcIso) < 20 THEN RETURN ?.
    IF SUBSTRING(pcIso, 5, 1) <> "-" OR SUBSTRING(pcIso, 8, 1) <> "-"
       OR SUBSTRING(pcIso, 11, 1) <> "T" OR SUBSTRING(pcIso, 14, 1) <> ":"
       OR SUBSTRING(pcIso, 17, 1) <> ":" THEN RETURN ?.
    ASSIGN iYr  = INTEGER(SUBSTRING(pcIso, 1, 4))  iMon = INTEGER(SUBSTRING(pcIso, 6, 2))
           iDay  = INTEGER(SUBSTRING(pcIso, 9, 2))  iHr  = INTEGER(SUBSTRING(pcIso, 12, 2))
           iMin = INTEGER(SUBSTRING(pcIso, 15, 2)) iSec  = INTEGER(SUBSTRING(pcIso, 18, 2))
           NO-ERROR.
    IF ERROR-STATUS:ERROR THEN RETURN ?.
    IF iMon < 1 OR iMon > 12 OR iDay < 1 OR iHr > 23 OR iMin > 59 OR iSec > 59 THEN RETURN ?.
    /* real calendar check: the day must exist in that month (leap years included) */
    IF iDay > fDaysInMonth(iYr, iMon) THEN RETURN ?.
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
        IF INTEGER(SUBSTRING(cRest, 2, 2)) > 23 OR INTEGER(SUBSTRING(cRest, 5, 2)) > 59 THEN RETURN ?.
    END.
    ELSE RETURN ?.
    dtRes = DATETIME-TZ(iMon, iDay, iYr, iHr, iMin, iSec, iMs, iTz) NO-ERROR.
    IF ERROR-STATUS:ERROR THEN RETURN ?.
    RETURN dtRes.
END FUNCTION.

