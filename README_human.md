# How I approached this project

Hello,

In this README, I explain why I chose this option, how I used AI during development,
and what challenges I encountered.

I chose the meeting transcripts option because it seemed to be the most challenging
one for AI. Natural conversations are noisy and unstructured. People interrupt each
other, make unclear statements, and sometimes change their minds.

I first asked Claude to propose a plan. I expected a much simpler solution: put the
transcripts and the user's question directly into the prompt. Claude explained that
this approach would not work well if the application eventually stored many
transcripts from different meetings. There would simply be too much text to send with
every question.

I then asked Claude to build the project. After a few hours, it had completed a
working application. I was surprised by the complexity of the solution. In hindsight,
I regret not starting with GPT-5.6. It is less ambitious and might have produced a
simpler and more precise solution at a lower cost.

I tested the application locally with a transcript generated using another AI
assistant. I deliberately added noise, unclear statements, and contradictions. This
test exposed weaknesses in the transcript parser, citation handling, and refusal
logic. Claude addressed these problems in a second pass.

I also found a few user-interface issues. For example, the **New conversation**
button was initially missing and was later too difficult to see. I asked Claude to
add it and then make it more visible.

Claude wrote the first version of the technical documentation, which is now kept in
`README_AI.md`. That first version was too difficult to read because
it contained too many details and enumerations. I later asked GPT-5.6 to remove
unnecessary details and explain the technical ideas in simpler terms.

In conclusion, I am satisfied with the interface designed by Claude. However, Claude
took longer than I expected to produce a working application. It also designed an
architecture that may be more complex than this assignment required. The extra
complexity creates more opportunities for errors and makes debugging harder. I also
found that Claude struggled to communicate technical decisions clearly and concisely.