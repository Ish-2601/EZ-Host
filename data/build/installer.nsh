; Extra installer pages and wording for EZ Host (picked up by electron-builder).

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to EZ Host"
  !define MUI_WELCOMEPAGE_TEXT "EZ Host runs Minecraft and Project Zomboid servers on your own PC, so friends can join from anywhere.$\r$\n$\r$\nIt installs for your Windows account only and needs no administrator rights. Java, mod loaders and game servers download by themselves when you first need them.$\r$\n$\r$\nClick Next to continue."
  !define MUI_FINISHPAGE_TITLE "EZ Host is ready"
  !define MUI_FINISHPAGE_TEXT "EZ Host is installed. Open it, pick a game, and press New server. Your servers and settings are kept if you ever uninstall or update.$\r$\n$\r$\nClick Finish to close the installer."
  !define MUI_FINISHPAGE_LINK "Quick start guide"
  !define MUI_FINISHPAGE_LINK_LOCATION "https://github.com/Ish-2601/Self-Host-MC#quick-start"
  !insertmacro MUI_PAGE_WELCOME
!macroend
