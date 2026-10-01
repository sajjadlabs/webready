# Records docs/demo.gif, the terminal GIF at the top of the README.
#
#   1. Install vhs: https://github.com/charmbracelet/vhs
#   2. Put five or six photos (and a short video, if you like) in
#      examples/demo-project/media/
#   3. From the repository root: vhs docs/demo.tape

Output docs/demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1200
Set Height 760
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 70ms

Hide
Type "cd examples/demo-project && rm -rf media-web webready.config.json && clear"
Enter
Show

Type "npx webready"
Sleep 600ms
Enter
Sleep 2.5s

# The detected media folder
Enter
Sleep 2s

# Recommended settings
Enter
Sleep 2.5s

# Start
Enter
Sleep 8s

# Save the settings
Enter
Sleep 4s
