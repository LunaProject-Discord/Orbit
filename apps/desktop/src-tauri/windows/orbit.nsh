; Orbit の Windows インストーラー (windows/installer.nsi) の部品。
; tauri.conf.json の bundle.windows.nsis.installerHooks としてテンプレートの先頭で読み込まれる。
; この時点では PRODUCTNAME などがまだ無いので、ここには定義とマクロだけを置き、
; 関数はテンプレートの中で ORBIT_FUNCTIONS を展開して作る。
;
; 見た目: ウィザード (次へ・次へ…) を出さず、ロゴと進み具合だけの小さな画面で入れて、終わったら起動する。
; アンインストールも確認 1 つだけ。色は assets/brand/README.md の暗い背景に合わせる。

; インストーラーの画像 (scripts/generate-assets.mjs が作る)。
; Windows の makensis は区切りが / のパスを見つけられないので、OS に合わせる (Linux でのビルドは / のみ)。
!ifdef NSIS_WIN32_MAKENSIS
  !define ORBIT_IMAGES "${__FILEDIR__}\images"
  !define ORBIT_LOGO "${ORBIT_IMAGES}\logo"
!else
  !define ORBIT_IMAGES "${__FILEDIR__}/images"
  !define ORBIT_LOGO "${ORBIT_IMAGES}/logo"
!endif

; 旧名。v0.2.0 までは「Orbit Mail」という名前で入っていた (識別子は同じ jp.lunaproject.orbit)。
!define ORBIT_LEGACY_NAME "Orbit Mail"
; 発行元も、v0.2.0 までは識別子から作られた「lunaproject」だった (今は Luna Project)。
!define ORBIT_LEGACY_MANUKEY "Software\lunaproject"
!define ORBIT_LEGACY_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${ORBIT_LEGACY_NAME}"

Var OrbitDpi
Var OrbitInner
Var OrbitFont
Var OrbitTitleFont
Var OrbitMigrated
Var OrbitLegacyDesktop
Var OrbitLegacyUninstaller
Var OrbitLegacyDir

; 画面の大きさ (拡大率 100% での px)。
!define ORBIT_WIDTH 440
!define ORBIT_HEIGHT 300
; 色。SetCtlColors は RRGGBB、プログレスバー (PBM_SETBARCOLOR) は 0x00BBGGRR。
!define ORBIT_BG "14162A"
!define ORBIT_TEXT "FFFFFF"
!define ORBIT_SUBTEXT "B8BDD8"
!define ORBIT_BAR 0x0036C6FF        ; #FFC636 (Luna Project の月の黄色)
!define ORBIT_BAR_TRACK 0x00482E2A  ; #2A2E48

!define /ifndef SW_HIDE 0
!define /ifndef SW_SHOW 5
!define /ifndef WM_SETFONT 0x0030
!define /ifndef STM_SETIMAGE 0x0172
!define /ifndef BM_SETCHECK 0x00F1
!define /ifndef BM_GETCHECK 0x00F0
!define /ifndef PBM_SETBARCOLOR 0x0409
!define /ifndef PBM_SETBKCOLOR 0x2001

; ショートカットを置くアプリ。どれも同じ実行ファイルを --app=<ID> 付きで起動する (src/launch.rs)。
; カレンダーと連絡先は、アプリにできたらここへ足す (アイコンは icons/apps/ に用意してある)。
!macro ORBIT_APPS MACRO
  !insertmacro ${MACRO} "mail" "Orbit Mail"
  ; !insertmacro ${MACRO} "calendar" "Orbit Calendar"
  ; !insertmacro ${MACRO} "contacts" "Orbit Contacts"
!macroend

; ---- 文言 ----------------------------------------------------------------------------------------
!macro ORBIT_LANG_STRINGS
  LangString orbitPreparing ${LANG_JAPANESE} "準備しています…"
  LangString orbitPreparing ${LANG_ENGLISH} "Getting ready…"
  LangString orbitInstalling ${LANG_JAPANESE} "Orbit をインストールしています…"
  LangString orbitInstalling ${LANG_ENGLISH} "Installing Orbit…"
  LangString orbitMigrating ${LANG_JAPANESE} "以前の Orbit Mail を置き換えています…"
  LangString orbitMigrating ${LANG_ENGLISH} "Replacing the previous Orbit Mail…"
  LangString orbitFinishing ${LANG_JAPANESE} "まもなく完了します…"
  LangString orbitFinishing ${LANG_ENGLISH} "Almost done…"
  LangString orbitInstallFailed ${LANG_JAPANESE} "Orbit をインストールできませんでした。もう一度インストーラーを実行してください。"
  LangString orbitInstallFailed ${LANG_ENGLISH} "Orbit could not be installed. Please run the installer again."
  LangString orbitClose ${LANG_JAPANESE} "閉じる"
  LangString orbitClose ${LANG_ENGLISH} "Close"
  LangString orbitUninstallTitle ${LANG_JAPANESE} "Orbit をアンインストールしますか?"
  LangString orbitUninstallTitle ${LANG_ENGLISH} "Uninstall Orbit?"
  LangString orbitUninstallBody ${LANG_JAPANESE} "Orbit Mail などの Orbit のアプリを、このパソコンから削除します。メールはサーバーに残るので、入れ直せばまた使えます。"
  LangString orbitUninstallBody ${LANG_ENGLISH} "Orbit Mail and the other Orbit apps will be removed from this PC. Your mail stays on the server, so you can reinstall at any time."
  LangString orbitDeleteData ${LANG_JAPANESE} "このパソコンに保存したデータ (ログイン状態・設定・キャッシュ) も削除する"
  LangString orbitDeleteData ${LANG_ENGLISH} "Also delete data saved on this PC (sign-in, settings and cache)"
  LangString orbitUninstallButton ${LANG_JAPANESE} "アンインストール"
  LangString orbitUninstallButton ${LANG_ENGLISH} "Uninstall"
  LangString orbitCancel ${LANG_JAPANESE} "キャンセル"
  LangString orbitCancel ${LANG_ENGLISH} "Cancel"
  LangString orbitUninstalling ${LANG_JAPANESE} "Orbit をアンインストールしています…"
  LangString orbitUninstalling ${LANG_ENGLISH} "Uninstalling Orbit…"
  LangString orbitUninstalled ${LANG_JAPANESE} "Orbit をアンインストールしました。"
  LangString orbitUninstalled ${LANG_ENGLISH} "Orbit has been uninstalled."
  LangString orbitUninstallFailed ${LANG_JAPANESE} "Orbit をアンインストールできませんでした。Orbit を終了してから、もう一度お試しください。"
  LangString orbitUninstallFailed ${LANG_ENGLISH} "Orbit could not be uninstalled. Quit Orbit and try again."
!macroend

; 画面の下の状態の文字だけを変える (詳細の一覧は出さない)。
!macro ORBIT_STATUS TEXT
  SetDetailsPrint textonly
  DetailPrint "${TEXT}"
  SetDetailsPrint none
!macroend

; インストーラーとアンインストーラーに画像を入れ、一時フォルダーへ取り出す (.onInit / un.onInit)。
!macro ORBIT_EXTRACT_IMAGES
  InitPluginsDir
  File "/oname=$PLUGINSDIR\orbit-logo-100.bmp" "${ORBIT_LOGO}-100.bmp"
  File "/oname=$PLUGINSDIR\orbit-logo-125.bmp" "${ORBIT_LOGO}-125.bmp"
  File "/oname=$PLUGINSDIR\orbit-logo-150.bmp" "${ORBIT_LOGO}-150.bmp"
  File "/oname=$PLUGINSDIR\orbit-logo-200.bmp" "${ORBIT_LOGO}-200.bmp"
!macroend

; 100% のときの px を、画面の拡大率に合わせた px にする。
!macro ORBIT_PX OUT VALUE
  IntOp ${OUT} ${VALUE} * $OrbitDpi
  IntOp ${OUT} ${OUT} / 96
!macroend

!macro ORBIT_HIDE PARENT ID
  GetDlgItem $0 ${PARENT} ${ID}
  ShowWindow $0 ${SW_HIDE}
!macroend

; 子のウィンドウを置く (x, y, 幅, 高さは 100% のときの px)。
!macro ORBIT_PLACE HWND X Y W H
  !insertmacro ORBIT_PX $R5 ${X}
  !insertmacro ORBIT_PX $R6 ${Y}
  !insertmacro ORBIT_PX $R7 ${W}
  !insertmacro ORBIT_PX $R8 ${H}
  System::Call "user32::SetWindowPos(p ${HWND}, p 0, i R5, i R6, i R7, i R8, i 0x14)"
!macroend

; ---- ショートカット --------------------------------------------------------------------------------
; ショートカットには、アプリ本体と同じ AppUserModelID (識別子) を付ける。Windows の通知とタスクバーの
; まとまりは、この ID のショートカットの名前とアイコンを使う。
!macro ORBIT_CREATE_START_MENU ID TITLE
  CreateShortcut "$SMPROGRAMS\${TITLE}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "--app=${ID}" "$INSTDIR\icons\orbit-${ID}.ico" 0
  !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${TITLE}.lnk"
!macroend

!macro ORBIT_CREATE_DESKTOP ID TITLE
  CreateShortcut "$DESKTOP\${TITLE}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "--app=${ID}" "$INSTDIR\icons\orbit-${ID}.ico" 0
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${TITLE}.lnk"
!macroend

; このインストール先の実行ファイルを指しているときだけ消す (ほかの場所の Orbit のものは残す)。
!macro ORBIT_DELETE_SHORTCUT LNK
  !insertmacro IsShortcutTarget "${LNK}" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 = 1
    !insertmacro UnpinShortcut "${LNK}"
    Delete "${LNK}"
  ${EndIf}
!macroend

!macro ORBIT_DELETE_SHORTCUTS ID TITLE
  !insertmacro ORBIT_DELETE_SHORTCUT "$SMPROGRAMS\${TITLE}.lnk"
  !insertmacro ORBIT_DELETE_SHORTCUT "$DESKTOP\${TITLE}.lnk"
!macroend

; ---- 関数 (UN が "" ならインストーラー、"un." ならアンインストーラーの分) ------------------------
!macro ORBIT_FUNCTIONS UN
  ; 枠の無い小さな画面にする。NSIS のウィザードの部品 (見出し、ボタン、区切り線) は隠す。
  Function ${UN}OrbitCompactWindow
    System::Call "user32::GetDpiForWindow(p $HWNDPARENT) i .r0"
    StrCpy $OrbitDpi 96
    ${If} $0 != "error"
    ${AndIf} $0 >= 96
      StrCpy $OrbitDpi $0
    ${EndIf}

    ; 1028/1256: 下の文字、1034〜1039: 見出し、1035/1036/1045: 区切り線、1〜3: ボタン
    !insertmacro ORBIT_HIDE $HWNDPARENT 1028
    !insertmacro ORBIT_HIDE $HWNDPARENT 1256
    !insertmacro ORBIT_HIDE $HWNDPARENT 1034
    !insertmacro ORBIT_HIDE $HWNDPARENT 1035
    !insertmacro ORBIT_HIDE $HWNDPARENT 1036
    !insertmacro ORBIT_HIDE $HWNDPARENT 1037
    !insertmacro ORBIT_HIDE $HWNDPARENT 1038
    !insertmacro ORBIT_HIDE $HWNDPARENT 1039
    !insertmacro ORBIT_HIDE $HWNDPARENT 1045
    !insertmacro ORBIT_HIDE $HWNDPARENT 1
    !insertmacro ORBIT_HIDE $HWNDPARENT 2
    !insertmacro ORBIT_HIDE $HWNDPARENT 3

    ; タイトルバーと枠を外す (WS_CAPTION、WS_SYSMENU、WS_THICKFRAME、最小化・最大化、DS_MODALFRAME)。
    System::Call "user32::GetWindowLongW(p $HWNDPARENT, i -16) i .r0"
    IntOp $0 $0 & 0xFF30FF7F
    System::Call "user32::SetWindowLongW(p $HWNDPARENT, i -16, i r0)"
    System::Call "user32::GetWindowLongW(p $HWNDPARENT, i -20) i .r0"
    IntOp $0 $0 & 0xFFFFFCFE
    System::Call "user32::SetWindowLongW(p $HWNDPARENT, i -20, i r0)"

    ; 作業領域 (タスクバーを除いた画面) の真ん中に置く。
    !insertmacro ORBIT_PX $1 ${ORBIT_WIDTH}
    !insertmacro ORBIT_PX $2 ${ORBIT_HEIGHT}
    System::Call "*(i, i, i, i) p .r3"
    System::Call "user32::SystemParametersInfoW(i 0x30, i 0, p r3, i 0)"
    System::Call "*$3(i .r4, i .r5, i .r6, i .r7)"
    System::Free $3
    IntOp $6 $6 - $4
    IntOp $6 $6 - $1
    IntOp $6 $6 / 2
    IntOp $6 $6 + $4
    IntOp $7 $7 - $5
    IntOp $7 $7 - $2
    IntOp $7 $7 / 2
    IntOp $7 $7 + $5
    System::Call "user32::SetWindowPos(p $HWNDPARENT, p 0, i r6, i r7, i r1, i r2, i 0x24)"

    ; Windows 11 では角を丸める (DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND)。それより前の Windows では何もしない。
    System::Call "*(i 2) p .r3"
    System::Call "dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 33, p r3, i 4)"
    System::Free $3

    SetCtlColors $HWNDPARENT "" "${ORBIT_BG}"

    ${If} $OrbitFont == ""
      CreateFont $OrbitFont "Yu Gothic UI" 9 400
      CreateFont $OrbitTitleFont "Yu Gothic UI" 13 700
    ${EndIf}
  FunctionEnd

  ; ページの中身 ($OrbitInner) を画面いっぱいに広げ、ボタンより後ろに置く。
  Function ${UN}OrbitFillInner
    !insertmacro ORBIT_PX $1 ${ORBIT_WIDTH}
    !insertmacro ORBIT_PX $2 ${ORBIT_HEIGHT}
    System::Call "user32::SetWindowPos(p $OrbitInner, p 1, i 0, i 0, i r1, i r2, i 0x10)"
    SetCtlColors $OrbitInner "" "${ORBIT_BG}"
  FunctionEnd

  ; ロゴを置く。$R0 = 上端 (100% のときの px)、$R1 = 1 なら中央、0 なら左寄せ (左の余白 40px)。
  Function ${UN}OrbitLogo
    ${If} $OrbitDpi >= 192
      StrCpy $3 200
    ${ElseIf} $OrbitDpi >= 144
      StrCpy $3 150
    ${ElseIf} $OrbitDpi >= 120
      StrCpy $3 125
    ${Else}
      StrCpy $3 100
    ${EndIf}
    System::Call "user32::LoadImageW(p 0, w '$PLUGINSDIR\orbit-logo-$3.bmp', i 0, i 0, i 0, i 0x10) p .r2"
    ${If} $R1 = 1
      StrCpy $4 0
      !insertmacro ORBIT_PX $5 ${ORBIT_WIDTH}
    ${Else}
      !insertmacro ORBIT_PX $4 40
      !insertmacro ORBIT_PX $5 168
    ${EndIf}
    !insertmacro ORBIT_PX $6 $R0
    !insertmacro ORBIT_PX $7 72
    ; WS_CHILD | WS_VISIBLE | SS_BITMAP | SS_CENTERIMAGE
    System::Call "user32::CreateWindowExW(i 0, w 'STATIC', w '', i 0x5000020E, i r4, i r6, i r5, i r7, p $OrbitInner, p 0, p 0, p 0) p .r0"
    SendMessage $0 ${STM_SETIMAGE} 0 $2
  FunctionEnd

  ; インストール中 (アンインストール中) の画面: ロゴ、状態の文字、細いプログレスバーだけ。
  Function ${UN}OrbitInstFilesShow
    Call ${UN}OrbitCompactWindow
    FindWindow $OrbitInner "#32770" "" $HWNDPARENT
    Call ${UN}OrbitFillInner
    !insertmacro ORBIT_HIDE $OrbitInner 1016
    !insertmacro ORBIT_HIDE $OrbitInner 1027

    StrCpy $R0 82
    StrCpy $R1 1
    Call ${UN}OrbitLogo

    ; 状態の文字 (中央ぞろえ)
    GetDlgItem $0 $OrbitInner 1006
    System::Call "user32::GetWindowLongW(p r0, i -16) i .r1"
    IntOp $1 $1 | 0x1
    System::Call "user32::SetWindowLongW(p r0, i -16, i r1)"
    SetCtlColors $0 "${ORBIT_SUBTEXT}" "${ORBIT_BG}"
    SendMessage $0 ${WM_SETFONT} $OrbitFont 1
    IntOp $1 ${ORBIT_WIDTH} - 48
    !insertmacro ORBIT_PLACE $0 24 176 $1 22

    ; プログレスバー: OS の見た目 (テーマ) を外して、ブランドの色の細い線にする。
    GetDlgItem $0 $OrbitInner 1004
    System::Call "uxtheme::SetWindowTheme(p r0, w '', w '')"
    System::Call "user32::GetWindowLongW(p r0, i -16) i .r1"
    IntOp $1 $1 & 0xFF7FFFFF
    System::Call "user32::SetWindowLongW(p r0, i -16, i r1)"
    System::Call "user32::SetWindowLongW(p r0, i -20, i 0)"
    SendMessage $0 ${PBM_SETBARCOLOR} 0 ${ORBIT_BAR}
    SendMessage $0 ${PBM_SETBKCOLOR} 0 ${ORBIT_BAR_TRACK}
    IntOp $1 ${ORBIT_WIDTH} - 220
    IntOp $1 $1 / 2
    !insertmacro ORBIT_PLACE $0 $1 214 220 4
    System::Call "user32::SetWindowPos(p r0, p 0, i 0, i 0, i 0, i 0, i 0x37)"
  FunctionEnd

  ; 失敗したときは、閉じるボタンだけを右下に出す。
  Function ${UN}OrbitShowCloseButton
    GetDlgItem $0 $HWNDPARENT 2
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(orbitClose)"
    IntOp $1 ${ORBIT_WIDTH} - 120
    IntOp $2 ${ORBIT_HEIGHT} - 48
    !insertmacro ORBIT_PLACE $0 $1 $2 100 30
    EnableWindow $0 1
    ShowWindow $0 ${SW_SHOW}
  FunctionEnd
!macroend

; ---- インストーラーだけの関数 --------------------------------------------------------------------
!macro ORBIT_INSTALLER_FUNCTIONS
  ; 旧名 (Orbit Mail) で入っていたら、その版のアンインストーラーで静かに取り除く。
  ; データ (%APPDATA%\jp.lunaproject.orbit など) は識別子が同じなので残り、ログインもそのまま使える。
  ; 自動更新 (/UPDATE) で呼ばれたときも同じように置き換え、ショートカットを作り直す。
  Function OrbitMigrateLegacy
    StrCpy $OrbitMigrated 0
    StrCpy $OrbitLegacyDesktop 0
    ReadRegStr $OrbitLegacyUninstaller SHCTX "${ORBIT_LEGACY_UNINSTKEY}" "UninstallString"
    ${If} $OrbitLegacyUninstaller == ""
      Return
    ${EndIf}
    ReadRegStr $OrbitLegacyDir SHCTX "${ORBIT_LEGACY_MANUKEY}\${ORBIT_LEGACY_NAME}" ""
    ${If} $OrbitLegacyDir == ""
      ; InstallLocation は "C:\…" のように引用符で囲まれている。
      ReadRegStr $OrbitLegacyDir SHCTX "${ORBIT_LEGACY_UNINSTKEY}" "InstallLocation"
      StrCpy $0 $OrbitLegacyDir 1
      ${If} $0 == '"'
        StrCpy $OrbitLegacyDir $OrbitLegacyDir "" 1
        StrCpy $OrbitLegacyDir $OrbitLegacyDir -1
      ${EndIf}
    ${EndIf}

    !insertmacro ORBIT_STATUS "$(orbitMigrating)"
    ${If} ${FileExists} "$DESKTOP\${ORBIT_LEGACY_NAME}.lnk"
      StrCpy $OrbitLegacyDesktop 1
    ${EndIf}
    ${If} $OrbitLegacyDir != ""
      !insertmacro CheckIfAppIsRunning "$OrbitLegacyDir\${MAINBINARYNAME}.exe" "${ORBIT_LEGACY_NAME}"
      ; その場で動かす (_?=) と、アンインストーラー自身とフォルダーは残るので、後で消す。
      ExecWait '$OrbitLegacyUninstaller /S _?=$OrbitLegacyDir' $0
    ${Else}
      ExecWait '$OrbitLegacyUninstaller /S' $0
    ${EndIf}
    ${If} ${Errors}
      StrCpy $0 2
    ${EndIf}
    ${If} $0 = 0
      ${If} $OrbitLegacyDir != ""
      ${AndIf} $OrbitLegacyDir != $INSTDIR
        Delete "$OrbitLegacyDir\uninstall.exe"
        RMDir "$OrbitLegacyDir"
      ${EndIf}
      StrCpy $OrbitMigrated 1
    ${Else}
      DetailPrint "Orbit Mail のアンインストーラーが失敗しました (終了コード $0)"
    ${EndIf}
    ; 旧名のインストール先とインストーラーの言語の記録。
    DeleteRegKey SHCTX "${ORBIT_LEGACY_MANUKEY}\${ORBIT_LEGACY_NAME}"
    DeleteRegKey /ifempty SHCTX "${ORBIT_LEGACY_MANUKEY}"
    DeleteRegKey HKCU "${ORBIT_LEGACY_MANUKEY}\${ORBIT_LEGACY_NAME}"
    DeleteRegKey /ifempty HKCU "${ORBIT_LEGACY_MANUKEY}"
    !insertmacro ORBIT_STATUS "$(orbitInstalling)"
  FunctionEnd

  ; MSI (WiX) 版の Orbit / Orbit Mail が入っていたら、先に取り除く (同じアプリが 2 つ入らないように)。
  Function OrbitRemoveWixInstall
    StrCpy $0 0
    wix_loop:
      EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
      StrCmp $1 "" wix_done
      IntOp $0 $0 + 1
      ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
      ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
      ${If} $R1 != "${MANUFACTURER}"
      ${AndIf} $R1 != "lunaproject"
        Goto wix_loop
      ${EndIf}
      ${If} $R0 != "${PRODUCTNAME}"
      ${AndIf} $R0 != "${ORBIT_LEGACY_NAME}"
        Goto wix_loop
      ${EndIf}
      ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
      ${StrCase} $R1 $R0 "L"
      ${StrLoc} $R2 $R1 "msiexec" ">"
      StrCmp $R2 0 0 wix_loop
      !insertmacro ORBIT_STATUS "$(orbitMigrating)"
      ExecWait '$R0 /passive /norestart'
      StrCpy $WixMode 1
      !insertmacro ORBIT_STATUS "$(orbitInstalling)"
      ; 消したので、一覧の数え方がずれる。最初から数え直す。
      StrCpy $0 0
      Goto wix_loop
    wix_done:
  FunctionEnd

  ; スタートメニューとデスクトップに、アプリごとのショートカットを作る。
  ; 自動更新 (/UPDATE) では作り直さない (消したショートカットが戻らないように)。
  ; ただし旧名や MSI 版から置き換えたときは、消えた分を作る。
  Function OrbitCreateShortcuts
    ${If} $NoShortcutMode = 1
      Return
    ${EndIf}
    ${If} $UpdateMode = 1
    ${AndIf} $OrbitMigrated <> 1
    ${AndIf} $WixMode <> 1
      Return
    ${EndIf}
    !insertmacro ORBIT_APPS ORBIT_CREATE_START_MENU
    ${If} $UpdateMode <> 1
    ${OrIf} $OrbitLegacyDesktop = 1
      !insertmacro ORBIT_APPS ORBIT_CREATE_DESKTOP
    ${EndIf}
  FunctionEnd
!macroend

; ---- アンインストーラーだけの関数 ----------------------------------------------------------------
!macro ORBIT_UNINSTALLER_FUNCTIONS
  ; 確認の画面: ロゴ、見出し、説明、データも消すかのチェック、ボタン 2 つ。
  Function un.OrbitConfirmCreate
    ${If} $PassiveMode = 1
      Abort
    ${EndIf}
    nsDialogs::Create 1018
    Pop $OrbitInner
    ${If} $OrbitInner == error
      Abort
    ${EndIf}
    Call un.OrbitCompactWindow
    Call un.OrbitFillInner

    StrCpy $R0 26
    StrCpy $R1 0
    Call un.OrbitLogo

    IntOp $1 ${ORBIT_WIDTH} - 80
    ${NSD_CreateLabel} 0 0 0 0 "$(orbitUninstallTitle)"
    Pop $0
    SetCtlColors $0 "${ORBIT_TEXT}" "${ORBIT_BG}"
    SendMessage $0 ${WM_SETFONT} $OrbitTitleFont 1
    !insertmacro ORBIT_PLACE $0 40 104 $1 28

    ${NSD_CreateLabel} 0 0 0 0 "$(orbitUninstallBody)"
    Pop $0
    SetCtlColors $0 "${ORBIT_SUBTEXT}" "${ORBIT_BG}"
    SendMessage $0 ${WM_SETFONT} $OrbitFont 1
    !insertmacro ORBIT_PLACE $0 40 136 $1 44

    ; チェックボックスの文字は、テーマが有効だと色を変えられないので、横に別のラベルを置く (押しても切り替わる)。
    ${NSD_CreateCheckbox} 0 0 0 0 ""
    Pop $DeleteAppDataCheckbox
    SetCtlColors $DeleteAppDataCheckbox "" "${ORBIT_BG}"
    !insertmacro ORBIT_PLACE $DeleteAppDataCheckbox 40 192 16 18
    IntOp $1 $1 - 24
    ${NSD_CreateLabel} 0 0 0 0 "$(orbitDeleteData)"
    Pop $0
    ; SS_NOTIFY (押されたことを知らせる)
    System::Call "user32::GetWindowLongW(p r0, i -16) i .r2"
    IntOp $2 $2 | 0x100
    System::Call "user32::SetWindowLongW(p r0, i -16, i r2)"
    SetCtlColors $0 "${ORBIT_SUBTEXT}" "${ORBIT_BG}"
    SendMessage $0 ${WM_SETFONT} $OrbitFont 1
    !insertmacro ORBIT_PLACE $0 64 192 $1 36
    ${NSD_OnClick} $0 un.OrbitToggleDeleteData

    ; ボタン (NSIS の「次へ」と「キャンセル」を使う)
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(orbitUninstallButton)"
    IntOp $1 ${ORBIT_WIDTH} - 160
    IntOp $2 ${ORBIT_HEIGHT} - 52
    !insertmacro ORBIT_PLACE $0 $1 $2 120 32
    ShowWindow $0 ${SW_SHOW}
    GetDlgItem $0 $HWNDPARENT 2
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(orbitCancel)"
    IntOp $1 $1 - 128
    !insertmacro ORBIT_PLACE $0 $1 $2 120 32
    ShowWindow $0 ${SW_SHOW}

    nsDialogs::Show
  FunctionEnd

  Function un.OrbitToggleDeleteData
    SendMessage $DeleteAppDataCheckbox ${BM_GETCHECK} 0 0 $0
    ${If} $0 = 1
      SendMessage $DeleteAppDataCheckbox ${BM_SETCHECK} 0 0
    ${Else}
      SendMessage $DeleteAppDataCheckbox ${BM_SETCHECK} 1 0
    ${EndIf}
  FunctionEnd

  Function un.OrbitConfirmLeave
    SendMessage $DeleteAppDataCheckbox ${BM_GETCHECK} 0 0 $DeleteAppDataCheckboxState
  FunctionEnd
!macroend
