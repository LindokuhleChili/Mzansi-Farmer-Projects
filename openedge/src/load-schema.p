/* load-schema.p - load a .df into the connected (single-user) database.
   Usage: _progres -b -db farm -1 -p load-schema.p -param "C:\path\002-farm-ops.df" */
RUN prodict/load_df.p (SESSION:PARAMETER).
MESSAGE "SCHEMA LOAD DONE" SESSION:PARAMETER.
