/* norm.i - fNormText: the same normalisation as fDrNorm in doctor.i (lower case, a-z 0-9 %, digits split from letters,
   single spaces, one space padding each side). seed.p uses it to fill GuidePassage.SearchText. Keep identical to fDrNorm. */
FUNCTION fNormText RETURNS CHARACTER (INPUT pc AS CHARACTER):
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
