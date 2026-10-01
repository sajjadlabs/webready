# Records docs/demo.gif, the terminal GIF at the top of the README.
#
#   1. Install vhs: https://github.com/charmbracelet/vhs
#   2. Put five or six photos in examples/demo-project/media/
#      (Git ignores them: they never leave your machine)
#   3. From the repository root: vhs docs/demo.tape

Output docs/demo.gif

Require node

Set Shell "bash"
# Tall enough for the whole session to fit without scrolling: once the
# terminal scrolls, Wait+Screen stops seeing new lines.
Set FontSize 16
Set Width 1100
Set Height 900
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

# A few seconds of the progress bar, then skip ahead to the result.
# The report on screen says how long the encoding really took.
Sleep 4s
Hide
Wait+Screen@600s /Save these settings/
Show
Sleep 3s
Enter

# Finished when the shell prompt is back
Wait
Sleep 4s
