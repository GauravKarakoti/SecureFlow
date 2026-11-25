export function renderUserProfileVuln(container: HTMLElement, bioHtml: string) {
  // INSECURE: innerHTML assignment can execute embedded scripts
  container.innerHTML = bioHtml;
}
