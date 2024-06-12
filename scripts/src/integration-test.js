#!/usr/bin/env node

const {execFileSync, spawnSync} = require('child_process')
const axios = require('axios')
const path = require('path')
const fs = require('fs')
const {unfurlGuiRoot} = require('./shared/util.js')

const OC_USERNAME = process.env.OC_USERNAME
const OC_PASSWORD = process.env.OC_PASSWORD
let PORT = process.env.PORT
const OC_URL = process.env.OC_URL || (PORT? `http://localhost:${PORT}`: 'http://localhost:5001')
const OC_INVITE_CODE = process.env.OC_INVITE_CODE
const OC_DISCRIMINATOR = process.env.OC_DISCRIMINATOR
const EXTERNAL = process.env.hasOwnProperty('EXTERNAL')? process.env['EXTERNAL'] || '1' : '1'
const STANDALONE_UNFURL = OC_URL.includes('://localhost') 
const ENV_NAMING_FUNCTION = process.env.ENV_NAMING_FUNCTION || (STANDALONE_UNFURL? 'identity' : 'identifierFromCurrentTime')
const UNFURL_TEST_TMPDIR = path.resolve(process.env.UNFURL_TEST_TMPDIR || "/tmp")
const STANDALONE_PROJECT_DIR = `${UNFURL_TEST_TMPDIR}/ufsv`
if(STANDALONE_UNFURL && ! PORT) {
  PORT = new URL(OC_URL).port
}

const GENERATED_PASSWORD = !STANDALONE_UNFURL && btoa(Number.MAX_SAFE_INTEGER * Math.random())
const FIXTURES_TMP = path.join(unfurlGuiRoot, 'cypress/fixtures/tmp')

process.env.OC_URL = OC_URL
process.env.DASHBOARD_DEST = (
  process.env.DASHBOARD_DEST ||
  STANDALONE_UNFURL? STANDALONE_PROJECT_DIR: undefined
)

const READ_ARGS = {
  username: (args) => args.u || args.username || (STANDALONE_UNFURL && 'jest' || undefined),
  cypressEnv: (args) => args.e || args.env || args['cypress-env'],
  dashboardRepo: (args) => args.dashboard || args['dashboard-repo'],
  group: (args) => args.group,
  REPOS_NAMESPACE: (args) => args.namespace || args['repo-namespace'] || args['repos-namespace'],
  awsAuthMethod: (args) => {
    const authMethod = args['aws-auth-method'] || args['aws-auth']
    switch(authMethod?.toLowerCase()) {
      case 'token': return 'token'
      case 'key': return 'token'
      default: return null
    }
  },
}

function readArgs(args) {
  const result = {}
  Object.entries(READ_ARGS).forEach(([argName, valueFn]) => result[argName] = valueFn(args) ?? null)
  return result
}

function fetchNamespaceProjects(namespace) {
  async function doFetch() {
    try {
      const projects = []
      for(let i = 1;; i++) {
        const url = `${OC_URL}/groups/${namespace}/-/children.json?page=${i}`
        const children = (await axios.get(url)).data
        if(children.length > 100) {
          throw new Error(`Encountered more than 100 "projects" on a page - "${namespace}" probably has a typo`)
        }
        if(children.length == 0) break
        for(const child of children) {
          if(child.type == 'project') {
            projects.push(child)
          }
        }
      }
      return projects
    } catch(e) {
      console.error(e)
      return []
    }
  }

  return fetchNamespaceProjects[namespace] || (fetchNamespaceProjects[namespace] = doFetch())
}

const ENVIORONMENT_VARIABLE_TRANSFORMATIONS = {
  'GOOGLE_APPLICATION_CREDENTIALS': (value) => {
    let dest = path.basename(value)

    // ci drops .json extension needed for fixtures
    if(!dest.endsWith('.json')) {
      dest = `${dest}.json`
    }
    fs.copyFileSync(value, path.join(FIXTURES_TMP, dest))
    return `/tmp/${dest}`
  }
}

function transformEnvironmentVariables(key, value) {

  let transformation
  if(transformation = ENVIORONMENT_VARIABLE_TRANSFORMATIONS[key]) {
    return transformation(value)
  }
  return value
}

const INTERNAL_TEST_VARIALBES = [
  'OC_IMPERSONATE',
  'DO_ENVIRONMENT_NAME',
  'AWS_ENVIRONMENT_NAME',
  'GCP_ENVIRONMENT_NAME',
  'AZ_ENVIRONMENT_NAME',
  'GENERATED_PASSWORD',
  'EXTERNAL',
  'NAMESPACE_PROJECTS'
]  // always overriden

const FORWARD_ENVIRONMENT_VARIABLES = [
  ...JSON.parse(fs.readFileSync(path.join(__dirname, 'forwarded-variables.json'), 'utf-8')),
  ...INTERNAL_TEST_VARIALBES
]



async function forwardedEnvironmentVariables(override) {
  const result = {}

  for(const envvar of FORWARD_ENVIRONMENT_VARIABLES) {
    let value = override[envvar] || process.env[envvar]
    if(value ?? null !== null) {
      result[`CYPRESS_${envvar}`] = transformEnvironmentVariables(envvar, value)
    }
  }
  return result
}


const ERROR_CREATE_USER_NO_DASHBOARD = 'A dashboard must be specified if a user is to be created.  Specify either --username or --dashboard-repo'

const ENV_NAMING_FUNCTIONS = {
  identifierFromCurrentTime(baseId) {
    const d = new Date(Date.now())

    const discriminator = OC_DISCRIMINATOR || d.toISOString().replace(/(:|\.|-)/g, '')
    return `${baseId}-${discriminator}`
  },
  identity(baseId) { return baseId}
}

function createDashboardCommand(username, dashboardRepo) {
  //if(!dashboardRepo) { throw new Error(ERROR_CREATE_USER_NO_DASHBOARD) }
  const
    file = path.join(__dirname, 'create-user.js'),
    args = ['--username', username, '--external', EXTERNAL],
    options = {stdio: 'inherit'}
  if(dashboardRepo) {
    args.push('--dashboard')
    args.push(dashboardRepo)
  }
  if(!(OC_USERNAME && OC_PASSWORD)) {
    args.push('--password')
    args.push(GENERATED_PASSWORD)
  }
  if(OC_INVITE_CODE) {
    args.push('--invite-code')
    args.push(OC_INVITE_CODE)
  }
  return () => {
    try {
      execFileSync(file, args, options)
      console.log(`Dashboard created for ${username}`)
    } catch(e) {
      console.error(e.message)
    }
  }
}

function invokeCypressCommand(baseArgs, forwardedEnv) {
  const args = ['run', 'cypress', ...baseArgs]
  const options = {stdio: 'inherit', env: {...process.env, ...forwardedEnv}}
  return spawnSync.bind(null, 'yarn', args, options)
}

async function main() {
  const args = require('minimist')(process.argv.slice(2))
  let prepareUserCommand

  const parsedArgs = readArgs(args)
  let {username, awsAuthMethod, cypressEnv, dashboardRepo, REPOS_NAMESPACE, group} = parsedArgs

  if(!REPOS_NAMESPACE) REPOS_NAMESPACE = 'testing'

  if(!username) {
    // we need to create a new user
    username = ENV_NAMING_FUNCTIONS.identifierFromCurrentTime('user')
    prepareUserCommand = createDashboardCommand(username, dashboardRepo)
  } else if (username == 'nobody') {
    username = undefined
  }

  if(username) console.log(`${process.env.OC_URL}/${username}/dashboard/-/deployments`)

  const GCP_ENVIRONMENT_NAME = ENV_NAMING_FUNCTIONS[ENV_NAMING_FUNCTION]('gcp').toLowerCase()
  const AWS_ENVIRONMENT_NAME = ENV_NAMING_FUNCTIONS[ENV_NAMING_FUNCTION]('aws').toLowerCase()
  const DO_ENVIRONMENT_NAME = ENV_NAMING_FUNCTIONS[ENV_NAMING_FUNCTION]('do').toLowerCase()
  const K8S_ENVIRONMENT_NAME = ENV_NAMING_FUNCTIONS[ENV_NAMING_FUNCTION]('k8s').toLowerCase()
  const AZ_ENVIRONMENT_NAME = ENV_NAMING_FUNCTIONS[ENV_NAMING_FUNCTION]('az').toLowerCase()
  const INTEGRATION_TEST_ARGS = JSON.stringify(parsedArgs)

  const NAMESPACE_PROJECTS = STANDALONE_UNFURL? []: (await fetchNamespaceProjects(REPOS_NAMESPACE)).map(p => p.name).join(',')

  if(!STANDALONE_UNFURL) {
    fs.writeFileSync(path.join(FIXTURES_TMP, 'namespace_projects.json'), JSON.stringify(await fetchNamespaceProjects(REPOS_NAMESPACE)))
  }

  let env = {OC_IMPERSONATE: username, GENERATED_PASSWORD, AWS_ENVIRONMENT_NAME, GCP_ENVIRONMENT_NAME, DO_ENVIRONMENT_NAME, K8S_ENVIRONMENT_NAME, AZ_ENVIRONMENT_NAME, REPOS_NAMESPACE, INTEGRATION_TEST_ARGS, NAMESPACE_PROJECTS}

  if(group) {
    env.DEFAULT_NAMESPACE = group
  }

  const forwardedEnv = await forwardedEnvironmentVariables(env)

  if(!username) {
    delete forwardedEnv['CYPRESS_OC_USERNAME']
    delete forwardedEnv['CYPRESS_OC_PASSWORD']
    delete forwardedEnv['CYPRESS_OC_IMPERSONATE']
  }

  const cypressCommand = invokeCypressCommand(args._, forwardedEnv)

  if(prepareUserCommand) prepareUserCommand()

  if(group) {
    console.log(`Attempting to create group ${group}`)
    try {
      execFileSync(path.join(__dirname, 'create-group.js'), [group], {stdio:'inherit'})
    } catch(e) { console.error(e.message) }
    console.log(`Attempting to add ${username} to ${group}`)
    try {
      execFileSync(path.join(__dirname, 'add-group-member.js'), ['--user', username, '--group', group], {stdio:'inherit'})
    } catch(e) { console.error(e.message) }

    if(dashboardRepo) {
      console.log(`Pushing dashboard to ${group}/dashboard`)
      try {
        execFileSync(path.join(__dirname, 'push-local-repo.js'), [dashboardRepo, '--project-path', `${group}/dashboard`], {stdio: 'inherit'})
      } catch(e) { console.error(e.message) }
    }
  }


  if(STANDALONE_UNFURL) {
    execFileSync('testing-shared/setup.sh', {
      env: {
        ...process.env,
        UNFURL_SERVER_CWD: process.env.DASHBOARD_DEST
      }
    })

    const UnfurlServer = (await import('../../testing-shared/unfurl-server.mjs')).default

    const unfurlServer = new UnfurlServer({
      cwd: STANDALONE_PROJECT_DIR,
      gui: true,
      env: {
        UNFURL_LOGGING: 'trace',
        UNFURL_HOME: '',
        UNFURL_SKIP_SAVE: 'never',
      },
      port: PORT,
      cloudServer: null,
      outfile: `${UNFURL_TEST_TMPDIR}/unfurl.log`
    })

    await unfurlServer.waitUntilReady()
  }
  const cypressResult = cypressCommand()
  console.log(cypressResult)
  const status = cypressResult.status
  if(status) {
    process.exit(status)
  }
}

async function tryMain() {
  try {
    await main()
  } catch(e) {
    console.error('Error:', e.message)
  }
}

tryMain()
