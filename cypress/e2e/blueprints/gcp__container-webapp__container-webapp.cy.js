import {deploymentFixturePath} from '../../support/deployment-fixture'

const SPEC = 'gcp__container-webapp__container-webapp'
const FIXTURE = deploymentFixturePath(SPEC)

const GITHUB_USERNAME = Cypress.env('GITHUB_USERNAME') || 'onecommons-dummy-220819'
const GITHUB_ACCESS_TOKEN = Cypress.env('GITHUB_ACCESS_TOKEN')
const BASE_TIMEOUT = Cypress.env('BASE_TIMEOUT')
const DRYRUN = Cypress.env('DRYRUN')

const repoName = `buildpack-test-app-${Date.now().toString(36)}`

if(!DRYRUN) {
  describe(SPEC, spec)
}

// TODO break this out into a dedicated helper
function spec() {
  before(() => {
    cy.exec(`curl "Accept: application/vnd.github+json" -H "Authorization: token ${GITHUB_ACCESS_TOKEN}" https://api.github.com/users/${GITHUB_USERNAME}/repos`).then(({stdout}) => {

      const repos = JSON.parse(stdout)
      let deleteRepo
      repos.filter(repo => repo.name.startsWith('buildpack-test-app-')).forEach(repo => {
        deleteRepo = `curl -X DELETE -H "Accept: application/vnd.github+json" -H "Authorization: token ${GITHUB_ACCESS_TOKEN}" https://api.github.com/repos/${GITHUB_USERNAME}/${repo.name}`
        console.log({deleteRepo})
        cy.exec(deleteRepo, {failOnNonZeroExit: false})
      })

      const fork = `curl -X POST -H "Accept: application/vnd.github+json" -H "Authorization: token ${GITHUB_ACCESS_TOKEN}" https://api.github.com/repos/AjBreidenbach/buildpack-test-app/forks`

      // putting the name in the fork payload wasn't working as expected
      // we're also going to set this private
      const rename = `curl -X PATCH -H "Accept: application/vnd.github+json" -H "Authorization: token ${GITHUB_ACCESS_TOKEN}" -H "Content-Type: application/json" -d '{"name": "${repoName}", "visibility": "private"}' https://api.github.com/repos/${GITHUB_USERNAME}/buildpack-test-app`

      console.log({fork, rename, deleteRepo})
      cy.exec(fork)
      cy.exec(rename)
    })
  })

  it('Can recreate deployment', () => {
    cy.enterGithubToken()
    cy.recreateDeployment({
      verificationArgs: {repository: repoName},
      fixture: FIXTURE,
      afterRecreateDeployment() {
        cy.contains('.el-input-group__prepend', 'Github Project').next().type(`${GITHUB_USERNAME}/${repoName}`)
        cy.contains('button', 'Import').click({force: true})
        cy.contains('a', 'Container').click()
        cy.contains('a', 'Properties').click()
        cy.contains('.formily-element-form-item-label', 'ports').next().within(() => {
          cy.contains('button:visible', 'Add').click()
          cy.get('input.el-input__inner').type('5000:5000')
        })
        cy.contains('a', 'Environment Variables').click()
        cy.contains('button:visible', 'Add').click()
        cy.getInputOrTextarea('[placeholder="key"]').type('PORT')
        cy.getInputOrTextarea('[placeholder="value"]').type('5000')

        cy.contains('Redeploy every time').click()
        cy.contains('button', 'Imported', {timeout: BASE_TIMEOUT * 3})
        cy.wait(500)
      }
    })
  })
}
