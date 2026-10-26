/*------------------------------------------------------------------------
  web/AuthContext.cls - who is calling, for the current request only.
  web/FarmHandler.cls fills it from the PASOE client principal (basic login, see openedge/pasoe/README.md)
  before it runs farm-api.p, and resets it afterwards. In batch runs (run-contract.p, seed.p, the tamper test)
  nobody sets it, so CallerId is "" and farm-api.p keeps its previous behaviour (no role checks).
------------------------------------------------------------------------*/
BLOCK-LEVEL ON ERROR UNDO, THROW.

CLASS web.AuthContext:
    /* PASOE user id, e.g. farmapi or farmadmin. "" = no authenticated principal (batch or anonymous login model) */
    DEFINE PUBLIC STATIC PROPERTY CallerId AS CHARACTER NO-UNDO INITIAL "" GET. SET.
    /* comma list of roles from the client principal, without the ROLE_ prefix, e.g. PSCUser,PSCAdmin */
    DEFINE PUBLIC STATIC PROPERTY CallerRoles AS CHARACTER NO-UNDO INITIAL "" GET. SET.

    METHOD PUBLIC STATIC LOGICAL HasPrincipal():
        RETURN CallerId <> "" AND CallerId <> ?.
    END METHOD.

    METHOD PUBLIC STATIC LOGICAL HasRole(INPUT pcRole AS CHARACTER):
        DEFINE VARIABLE i AS INTEGER NO-UNDO.
        DEFINE VARIABLE cR AS CHARACTER NO-UNDO.
        DO i = 1 TO NUM-ENTRIES(CallerRoles):
            cR = TRIM(ENTRY(i, CallerRoles)).
            IF cR BEGINS "ROLE_" THEN cR = SUBSTRING(cR, 6).
            IF cR = pcRole THEN RETURN TRUE.
        END.
        RETURN FALSE.
    END METHOD.

    METHOD PUBLIC STATIC VOID Reset():
        ASSIGN CallerId = "" CallerRoles = "".
    END METHOD.
END CLASS.
