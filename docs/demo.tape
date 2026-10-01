# Records docs/demo.gif, the terminal GIF at the top of the README.
#
#   1. Install vhs: https://github.com/charmbracelet/vhs
#   2. Put five or six photos in examples/demo-project/media/
#      (Git ignores them: they never leave your machine)
#   3. From the repository root: vhs docs/demo.tape

Output docs/demo.gif

Require node

Set Shell "bash"
Set FontSize 18
Set Width 1200
Set Height 760
Set Padding 24
Set Framerate 30
Set Theme "Catppuccin Mocha"
Set TypingSpeed 70ms

# Off camera: start clean, and give this checkout's CLI its real command
# name, so the GIF can be recorded before webready is on npm.
Hide
Type "cd examples/demo-project && rm -rf media-web webready.config.json"
Enter
Type 'webready() { node ../../src/cli.js "$@"; }'
Enter
Type "clear"
Enter
Show

Type "webready"
Sleep 600ms
Enter

# The detected media folder
Wait+Screen /Which folder/
Sleep 1.5s
Enter

# Recommended settings
Wait+Screen /Recommended/
Sleep 2s
Enter

# The plan, then start
Wait+Screen /Start\?/
Sleep 2.5s
Enter

# Encoding takes as long as it takes
Wait+Screen@180s /Save these settings/
Sleep 2.5s
Enter

Wait+Screen /Your media is web-ready/
Sleep 4s
