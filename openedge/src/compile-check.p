/* compile-check.p - compile every program in this folder and print all compiler messages (no output files kept).
   Compiling farm-api.p also compiles coop.i (the co-op rules), which is an include, not a separate program.
   Usage: _progres -b -db farm -H localhost -S 20000 -p compile-check.p */
DEFINE VARIABLE cFile AS CHARACTER NO-UNDO EXTENT 5 INITIAL ["farm-api.p","seed.p","run-contract.p","web/FarmHandler.cls","load-schema.p"].
/* the OpenEdge.Web classes live in OpenEdge.Net.pl, which is not on the default PROPATH */
PROPATH = PROPATH + "," + RIGHT-TRIM(OS-GETENV("DLC"), "\") + "/tty/netlib/OpenEdge.Net.pl".
DEFINE VARIABLE i AS INTEGER NO-UNDO.
DEFINE VARIABLE j AS INTEGER NO-UNDO.

DO i = 1 TO EXTENT(cFile):
    COMPILE VALUE(cFile[i]) NO-ERROR.
    IF COMPILER:ERROR OR COMPILER:WARNING THEN DO:
        MESSAGE "COMPILE PROBLEMS in" cFile[i].
        DO j = 1 TO ERROR-STATUS:NUM-MESSAGES:
            MESSAGE ERROR-STATUS:GET-MESSAGE(j).
        END.
    END.
    ELSE MESSAGE "COMPILED OK:" cFile[i].
END.

