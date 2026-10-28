; Bit Viewer's Windows installer (NSIS), built by the release workflow:
;   makensis /DVERSION=3.0.0 /DEXE=path\to\bitviewer.exe /DOUT=setup.exe packaging\windows\installer.nsi
;
; Installs for the current user, where the 2.x (Tauri) app lived
; ($LOCALAPPDATA\Bit Viewer\BitViewer.exe), so it replaces that app in place:
; shortcuts, the .bitview association and the uninstall entry carry over.
;
; The in-app updater runs it with /P (passive: no questions, progress only)
; and /R (start Bit Viewer again afterwards), as the 2.x updater did.

Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define NAME "Bit Viewer"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NAME}"

Name "${NAME}"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\${NAME}"
InstallDirRegKey HKCU "Software\${NAME}" "InstallDir"
BrandingText "${NAME} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${NAME}"
VIAddVersionKey "FileDescription" "${NAME} installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "MIT License"

!define MUI_ICON "..\..\app\assets\app-icon\icon.ico"
!define MUI_UNICON "..\..\app\assets\app-icon\icon.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\BitViewer.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start ${NAME}"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Var Relaunch

Function .onInit
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/P" $1
  ${IfNot} ${Errors}
    SetSilent silent
  ${EndIf}
  ClearErrors
  ${GetOptions} $0 "/R" $1
  ${IfNot} ${Errors}
    StrCpy $Relaunch "1"
  ${EndIf}
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  ; the app that started an update is quitting: wait (up to 10 s) until
  ; its exe can be replaced
  StrCpy $2 0
  wait:
    ClearErrors
    FileOpen $3 "$INSTDIR\BitViewer.exe" a
    IfErrors 0 free
    IntOp $2 $2 + 1
    IntCmp $2 20 free
    Sleep 500
    Goto wait
  free:
  FileClose $3
  SetOverwrite on
  File "/oname=BitViewer.exe" "${EXE}"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  CreateShortCut "$SMPROGRAMS\${NAME}.lnk" "$INSTDIR\BitViewer.exe"

  ; .bitview workspaces open in Bit Viewer
  WriteRegStr HKCU "Software\Classes\.bitview" "" "BitViewer.Workspace"
  WriteRegStr HKCU "Software\Classes\BitViewer.Workspace" "" "Bit Viewer workspace"
  WriteRegStr HKCU "Software\Classes\BitViewer.Workspace\DefaultIcon" "" "$INSTDIR\BitViewer.exe,0"
  WriteRegStr HKCU "Software\Classes\BitViewer.Workspace\shell\open\command" "" '"$INSTDIR\BitViewer.exe" "%1"'

  WriteRegStr HKCU "Software\${NAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "kernel-dev"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\BitViewer.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" $0

  ${If} $Relaunch == "1"
    Exec '"$INSTDIR\BitViewer.exe"'
  ${EndIf}
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\BitViewer.exe"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${NAME}.lnk"
  DeleteRegKey HKCU "Software\Classes\BitViewer.Workspace"
  DeleteRegKey HKCU "Software\Classes\.bitview"
  DeleteRegKey HKCU "Software\${NAME}"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
