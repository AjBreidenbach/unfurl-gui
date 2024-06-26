const GOOGLE_APPLICATION_CREDENTIALS = Cypress.env('GOOGLE_APPLICATION_CREDENTIALS')
const GCP_ZONE = Cypress.env('CLOUDSDK_COMPUTE_ZONE') || 'us-central1-a'
const GCP_DNS_ZONE = Cypress.env('GCP_DNS_ZONE')
const GCP_DNS_TYPE = Cypress.env('GCP_DNS_TYPE')
const BASE_TIMEOUT = Cypress.env('BASE_TIMEOUT')
const USERNAME = Cypress.env('OC_IMPERSONATE')
const DASHBOARD_DEST = Cypress.env('DASHBOARD_DEST')

function createGCPEnvironment({environmentName, shouldCreateExternalResource, shouldCreateDNS}) {
  let environmentCreated

  cy.whenEnvironmentAbsent(environmentName, () => {
    cy.visit(`/${DASHBOARD_DEST}/-/environments`)
    cy.clickCreateEnvironmentButton()
    cy.completeEnvironmentDialog({environmentName, provider: 'gcp'})
    cy.url().should('include', environmentName)
    authenticateGCP()

    validateGCPEnvironment()
    environmentCreated = true
  })

  // create external resource
  if (shouldCreateExternalResource) {
    cy.whenInstancesAbsent(environmentName, () => {
      environmentCreated || cy.visit(`/${DASHBOARD_DEST}/-/environments/${environmentName}`)
      if(shouldCreateDNS) {
        cy.uncheckedCreateDNS(GCP_DNS_TYPE, GCP_DNS_ZONE)
      }
      cy.uncheckedCreateMail();
      cy.saveExternalResources()

      cy.checkMail()
    })
  }
}

function validateGCPEnvironment(filePath=GOOGLE_APPLICATION_CREDENTIALS) {
  cy.fixture(filePath).then(credentials => {
    cy.log(credentials.project_id)
    const {project_id} = credentials
    cy.contains(project_id, {timeout: BASE_TIMEOUT * 2.4}).should('be.visible')
    cy.contains(GCP_ZONE).should('be.visible')
    cy.contains('.properties-list-container', 'Generic', {matchCase: false}).should('not.exist')
  })
}

function authenticateGCP(filePath=GOOGLE_APPLICATION_CREDENTIALS, click=true) {
  cy.contains('button', 'Upload Service Account Key', {timeout: BASE_TIMEOUT * 2}).click()
  cy.getInputOrTextarea('[type="file"]').attachFile({
    encoding: 'utf-8',
    filePath,
    lastModified: new Date().getTime(),
    force: true
  })
  cy.get('button[data-toggle="dropdown"]').click()
  cy.getInputOrTextarea('[placeholder="Search zones"]').clear().type(GCP_ZONE)
  cy.contains('button', GCP_ZONE).should('be.visible')
  cy.contains('button', GCP_ZONE).click()
  if(click) {
    cy.contains('button', 'Save').click()
    cy.url({timeout: BASE_TIMEOUT * 2}).should('not.include', '/dashboard/-/clusters')
  }
}

Cypress.Commands.add('createGCPEnvironment', createGCPEnvironment)
Cypress.Commands.add('validateGCPEnvironment', validateGCPEnvironment)
Cypress.Commands.add('authenticateGCP', authenticateGCP)


