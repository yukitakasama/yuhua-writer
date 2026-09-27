#define AppName "Yuhua Writer"
#ifndef AppVersion
  #define AppVersion "0.1.0-alpha.2"
#endif
#ifndef OutputDir
  #define OutputDir "..\target\release\bundle\inno"
#endif

[Setup]
AppId={{8C9C9B5A-4E47-4B93-9B65-8D0F4B04A5F3}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Yuhua Writer Contributors
AppPublisherURL=https://github.com/yuhua-writer/yuhua-writer
DefaultDirName={localappdata}\Programs\Yuhua Writer
DefaultGroupName=Yuhua Writer
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename=YuhuaWriter_{#AppVersion}_inno_setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName=Yuhua Writer
SetupIconFile=..\src-tauri\icons\icon.ico
LicenseFile=..\LICENSE

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "..\target\release\yuhua-writer.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\extensions\*"; DestDir: "{app}\extensions"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist

[Icons]
Name: "{autoprograms}\Yuhua Writer"; Filename: "{app}\yuhua-writer.exe"
Name: "{autodesktop}\Yuhua Writer"; Filename: "{app}\yuhua-writer.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\yuhua-writer.exe"; Description: "Launch Yuhua Writer"; Flags: nowait postinstall skipifsilent
