; Single-file Windows installer for Deceive.
;
; Electrobun's Deceive-Setup.exe is already a per-user installer (install folder, shortcuts,
; Installed Apps entry, uninstaller), but it needs its hidden .installer\ payload next to it,
; so it ships as a zip. This wraps the extracted zip into one exe and runs Electrobun's setup.
;
; Built by scripts/package-windows.ts, which passes:
;   SOURCE      extracted Electrobun setup folder
;   OUTFILE     output exe path
;   ICON        app icon (.ico)
;   VERSION     app version (2.1.1)
;   VIVERSION   four-part version (2.1.1.0)
;   COPYRIGHT   copyright string

Unicode true

!macro RequireDefine NAME
  !ifndef ${NAME}
    !error "${NAME} is not defined; build this through scripts/package-windows.ts"
  !endif
!macroend
!insertmacro RequireDefine SOURCE
!insertmacro RequireDefine OUTFILE
!insertmacro RequireDefine ICON
!insertmacro RequireDefine VERSION
!insertmacro RequireDefine VIVERSION
!insertmacro RequireDefine COPYRIGHT

Name "Deceive"
Caption "Deceive Setup"
OutFile "${OUTFILE}"
Icon "${ICON}"
RequestExecutionLevel user
SilentInstall silent
SetCompressor /SOLID lzma

VIProductVersion "${VIVERSION}"
VIAddVersionKey /LANG=1033 "ProductName" "Deceive"
VIAddVersionKey /LANG=1033 "CompanyName" "League Deceiver"
VIAddVersionKey /LANG=1033 "FileDescription" "Deceive Setup"
VIAddVersionKey /LANG=1033 "FileVersion" "${VIVERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "${COPYRIGHT}"

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\setup"
  File /r "${SOURCE}\*.*"

  ExecWait '"$PLUGINSDIR\setup\Deceive-Setup.exe"' $0

  ; Leave the temporary folder so NSIS can delete it on exit
  SetOutPath "$TEMP"
  SetErrorLevel $0
SectionEnd
